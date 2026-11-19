/**
 * Uploads a built release (`bun cli/build.ts --all`) to the Cloudflare R2 release bucket through wrangler.
 *
 *   pnpm exec tsx scripts/release.ts                       dry run (the default): checks the build and lists every
 *                                                          object it would write; no network, no credentials
 *   pnpm exec tsx scripts/release.ts --publish             uploads to the bucket
 *     [--bucket vgate-releases] [--version x.y.z]
 *
 * Credentials come only from the environment: CLOUDFLARE_API_TOKEN (R2 edit on the account) and
 * CLOUDFLARE_ACCOUNT_ID. wrangler runs in an empty temporary directory, so no wrangler config, .env or .dev.vars of
 * this repository can change where or as whom it uploads.
 *
 * Order: the versioned objects first (manifest.json last among them: its presence marks a version complete), then
 * install.sh, latest.json and latest. A half-finished upload therefore never moves `latest` to a version that is not
 * all there. A version whose manifest is already in the bucket is never overwritten: releases are immutable.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs, str } from '../framework/cli/args.ts';
import {
  BASE_URL,
  BUCKET,
  BUCKET_PREFIX,
  NAME,
  PLATFORMS,
  platformId,
  VERSION_PATTERN,
  versionDir,
} from '../cli/release-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2), ['publish', 'dry-run']);
const publish = args.publish === true && args['dry-run'] !== true;
const bucket = str(args.bucket) ?? BUCKET;
const { version: packageVersion } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const version = str(args.version) ?? packageVersion;
if (!VERSION_PATTERN.test(version)) fail(`"${version}" is not a release version (x.y.z[-pre])`);

/** The object key of a path relative to the bucket's served root. */
const key = (path: string) => [BUCKET_PREFIX, path].filter(Boolean).join('/');

const releaseRoot = join(root, 'dist', 'release');
const vdir = versionDir(version);
const localVersionDir = join(releaseRoot, vdir);
const manifestPath = join(localVersionDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`No build of ${version} in dist/release: run \`bun cli/build.ts --all\` first`);

interface Manifest {
  name: string;
  version: string;
  baseUrl: string;
  assets: Array<{ platform: string; file: string; sha256: string; size: number }>;
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

// The release must be exactly what the manifest says, for every platform the config names.
const problems: string[] = [];
if (manifest.name !== NAME || manifest.version !== version) problems.push('manifest name/version do not match');
if (manifest.baseUrl !== BASE_URL) problems.push(`manifest baseUrl ${manifest.baseUrl} is not ${BASE_URL}: rebuild`);
for (const id of PLATFORMS.map(platformId)) {
  if (!manifest.assets.some((asset) => asset.platform === id)) problems.push(`no asset for ${id}`);
}
for (const asset of manifest.assets) {
  const path = join(localVersionDir, asset.file);
  if (!existsSync(path)) {
    problems.push(`${asset.file} is missing`);
    continue;
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== asset.sha256) problems.push(`${asset.file} does not match its manifest checksum`);
}
const installer = join(releaseRoot, 'install.sh');
const latestFile = join(releaseRoot, 'latest');
const latestJson = join(releaseRoot, 'latest.json');
for (const path of [installer, latestFile, latestJson, join(localVersionDir, 'SHA256SUMS')]) {
  if (!existsSync(path)) problems.push(`${path} is missing: rebuild`);
}
if (existsSync(latestFile) && readFileSync(latestFile, 'utf8').trim() !== version) {
  problems.push(`dist/release/latest names ${readFileSync(latestFile, 'utf8').trim()}, not ${version}: rebuild`);
}
if (existsSync(installer)) {
  const script = readFileSync(installer, 'utf8');
  if (script !== readFileSync(join(root, 'scripts', 'install.sh'), 'utf8')) {
    problems.push('dist/release/install.sh differs from scripts/install.sh: rebuild');
  }
  if (!script.includes(`VGATE_BASE_URL:-${BASE_URL}}`))
    problems.push(`install.sh's default base URL is not ${BASE_URL}`);
  if (!script.includes(`\nNAME=${NAME}\n`)) problems.push(`install.sh's NAME is not ${NAME}`);
}
// Every release from 0.6.0 on is signed, and the signature must verify against the published key (minisign.pub):
// install.sh refuses a release whose signature is missing or wrong, so an unsigned one would break every install.
const signature = join(localVersionDir, 'SHA256SUMS.minisig');
const publicKey = join(root, 'minisign.pub');
if (!existsSync(signature)) {
  // A dry run (CI's release build, which holds no key) only warns; publishing an unsigned release is refused.
  const unsigned = 'SHA256SUMS.minisig is missing: build with VGATE_MINISIGN_KEY=<secret key> (docs/releasing.md)';
  if (publish) problems.push(unsigned);
  else process.stderr.write(`warning: ${unsigned}; --publish would refuse this release\n`);
} else if (!existsSync(publicKey)) {
  problems.push('minisign.pub is missing at the repository root');
} else {
  const check = spawnSync('minisign', ['-Vm', join(localVersionDir, 'SHA256SUMS'), '-p', publicKey, '-x', signature], {
    encoding: 'utf8',
  });
  if (check.error) problems.push('minisign is not installed: the signature cannot be checked before publishing');
  else if (check.status !== 0)
    problems.push(`the signature does not verify against minisign.pub: ${check.stderr.trim()}`);
}
const releaseKey = readFileSync(publicKey, 'utf8').split('\n')[1]?.trim() ?? '';
if (
  existsSync(installer) &&
  releaseKey &&
  !readFileSync(installer, 'utf8').includes(`VGATE_MINISIGN_PUBKEY:-${releaseKey}}`)
) {
  problems.push("install.sh's default public key is not minisign.pub's");
}
if (problems.length > 0) fail(`Release ${version} is not publishable:\n  ${problems.join('\n  ')}`);

interface Upload {
  key: string;
  file: string;
  contentType: string;
  cacheControl: string;
}
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=60';
const versioned = (file: string, contentType: string): Upload => ({
  key: key(`${vdir}/${file}`),
  file: join(localVersionDir, file),
  contentType,
  cacheControl: IMMUTABLE,
});

const uploads: Upload[] = [
  ...manifest.assets.map((asset) => versioned(asset.file, 'application/gzip')),
  versioned('SHA256SUMS', 'text/plain; charset=utf-8'),
  ...(existsSync(join(localVersionDir, 'SHA256SUMS.minisig'))
    ? [versioned('SHA256SUMS.minisig', 'text/plain; charset=utf-8')]
    : []),
  versioned('manifest.json', 'application/json'),
  {
    key: key('install.sh'),
    file: installer,
    contentType: 'text/plain; charset=utf-8',
    cacheControl: 'public, max-age=300',
  },
  { key: key('latest.json'), file: latestJson, contentType: 'application/json', cacheControl: SHORT },
  { key: key('latest'), file: latestFile, contentType: 'text/plain; charset=utf-8', cacheControl: SHORT },
];

process.stdout.write(
  `${publish ? 'PUBLISH' : 'DRY RUN'} ${NAME} ${version} -> r2://${bucket}/ (served at ${BASE_URL})\n`,
);

if (!publish) {
  for (const upload of uploads) {
    const megabytes = (readFileSync(upload.file).length / 1024 / 1024).toFixed(2);
    process.stdout.write(
      `  would put ${upload.key}  (${megabytes} MB, ${upload.contentType}, ${upload.cacheControl})\n`,
    );
  }
  process.stdout.write(
    `Dry run: ${uploads.length} objects, nothing uploaded, bucket not contacted. ` +
      'Publish with --publish (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).\n',
  );
  process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) fail('--publish needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment');

// An empty working directory and an explicit environment: nothing in this repository configures the upload.
const sandbox = mkdtempSync(join(tmpdir(), 'vgate-release-'));
// fail() exits the process, which skips `finally`: clean up on exit instead.
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: account,
  WRANGLER_SEND_METRICS: 'false',
};

function wrangler(argv: string[]): { code: number | null; out: string } {
  const result = spawnSync('wrangler', argv, { cwd: sandbox, env, encoding: 'utf8' });
  if (result.error) fail(`Could not run wrangler: ${result.error.message}`);
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// Releases are immutable. Anything but a clear "not found" stops the release before it writes.
const check = wrangler(['r2', 'object', 'get', `${bucket}/${key(`${vdir}/manifest.json`)}`, '--remote', '--pipe']);
if (check.code === 0) fail(`${version} is already published in ${bucket}: releases are immutable, bump the version`);
if (!/does not exist|NoSuchKey|not found|404/i.test(check.out)) {
  fail(`Could not check the bucket ${bucket}:\n${check.out.trim()}`);
}

for (const upload of uploads) {
  process.stdout.write(`  put ${upload.key}\n`);
  const put = wrangler([
    'r2',
    'object',
    'put',
    `${bucket}/${upload.key}`,
    '--file',
    resolve(upload.file),
    '--content-type',
    upload.contentType,
    '--cache-control',
    upload.cacheControl,
    '--remote',
  ]);
  if (put.code !== 0) fail(`Upload of ${upload.key} failed; \`latest\` was not moved:\n${put.out.trim()}`);
}
process.stdout.write(`Published ${version}. Install: curl -fsSL ${BASE_URL}/install.sh | sh\n`);
