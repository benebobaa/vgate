/**
 * Spec-driven generated testing with Schemathesis, once per seeded identity. Schemathesis derives requests for
 * every operation from the vendored contract and checks: no 5xx, documented status codes, content types, headers
 * and response schemas. Results go to reports/schemathesis/<user>/ (JUnit) and reports/allure-results.
 *
 *   tsx framework/cli/schemathesis.ts --service example [--mode read-only|full] [--users reader,writer]
 *
 * read-only (the default, and what the gate runs) limits it to `schemathesis.readOnlyPaths` and/or
 * `schemathesis.readOnlyMethods`. full fuzzes every
 * operation, which writes random data: it refuses environments that are not disposable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { Auth } from '../auth/auth.ts';
import { cookieScheme, cookieValue } from '../auth/session.ts';
import { withoutTextStreamSchemas } from '../http/openapi.ts';
import { loadService, reportsDir } from '../config.ts';
import { fail, parseArgs, str } from './args.ts';

/** Pinned for reproducible runs; bump deliberately. */
const SCHEMATHESIS = 'schemathesis[allure]==4.32.7';
const ALLURE_COMMONS = 'allure-python-commons==2.16.2';

const args = parseArgs(process.argv.slice(2));
const svc = loadService(str(args.service));
// A UI service without a contract of its own has nothing to fuzz: it is verified through the browser (docs/frontend.md).
if (svc.ui && !existsSync(svc.specPath)) {
  process.stdout.write(`${svc.name} is a UI service without a contract: Schemathesis does not apply.\n`);
  process.exit(0);
}
const cfg = svc.schemathesis;
const mode = str(args.mode, 'read-only');
if (mode !== 'read-only' && mode !== 'full') fail(`--mode must be read-only or full, not ${mode}`);
if (mode === 'full' && !svc.env.disposable)
  fail(`--mode full writes random data; environment ${svc.env.name} is not disposable`);
if (mode === 'read-only' && !cfg.readOnlyPaths && !cfg.readOnlyMethods?.length)
  fail(`${svc.name} service.yaml has neither schemathesis.readOnlyPaths nor schemathesis.readOnlyMethods`);
const readOnly =
  mode === 'read-only'
    ? [
        ...(cfg.readOnlyPaths ? ['--include-path-regex', cfg.readOnlyPaths] : []),
        ...(cfg.readOnlyMethods ?? []).flatMap((method) => ['--include-method', method.toUpperCase()]),
      ]
    : [];

// A stream documented as `schema: { type: string }` would fail Schemathesis' event check (ST108) on every event: it
// reads that schema as the schema of each event. Schemathesis gets the contract without those schemas; the client's
// stream validation checks the events (docs/streaming.md).
const contract = parse(readFileSync(svc.specPath, 'utf8')) as Record<string, unknown>;
const adjusted = withoutTextStreamSchemas(contract);
let specPath = svc.specPath;
if (adjusted.removed.length > 0) {
  mkdirSync(resolve(reportsDir, 'schemathesis'), { recursive: true });
  specPath = resolve(reportsDir, 'schemathesis', 'contract.json');
  writeFileSync(specPath, JSON.stringify(adjusted.spec, null, 2));
  process.stdout.write(
    `Schemathesis does not check the events of ${adjusted.removed.length} stream(s) documented as a string ` +
      `(add an itemSchema to the contract to have it check them; the API tests validate them either way):\n` +
      adjusted.removed.map((where) => `  ${where}\n`).join(''),
  );
}

const users = (str(args.users)?.split(',') ?? cfg.users ?? Object.keys(svc.env.users)).filter(Boolean);
// One run per identity: with none, the step would pass having sent no request at all. A public API lists an
// anonymous user (one with neither password nor token).
if (users.length === 0)
  fail(`${svc.name} ${svc.env.name}: no user to run Schemathesis as (schemathesis.users is empty, or no users exist)`);
const auth = new Auth(svc.env);
let failed = false;

for (const user of users) {
  if (!svc.env.users[user]) fail(`No user "${user}" in ${svc.name} ${svc.env.name}`);
  // Every credential header: a session user sends its cookie and, when configured, a CSRF header.
  let headers = await auth.headerLines(user);
  const outDir = resolve(reportsDir, 'schemathesis', user);
  mkdirSync(outDir, { recursive: true });
  // A session cookie goes through the contract's cookie security scheme instead of a raw Cookie header: only then can
  // Schemathesis leave it out when it checks that a request without credentials is refused.
  const config: string[] = [];
  const session = svc.env.auth?.session;
  const cookieHeader = headers.find((line) => line.startsWith('Cookie: '));
  if (session && cookieHeader) {
    const scheme = cookieScheme(contract, session.cookie);
    const value = cookieValue(cookieHeader.slice('Cookie: '.length), session.cookie);
    if (scheme && value !== undefined) {
      const file = resolve(outDir, 'schemathesis.toml');
      writeFileSync(file, `[auth.openapi.${JSON.stringify(scheme)}]\napi_key = ${JSON.stringify(value)}\n`);
      config.push('--config-file', file);
      headers = headers.filter((line) => line !== cookieHeader);
    }
  }
  const argv = [
    '--with',
    ALLURE_COMMONS,
    '--from',
    SCHEMATHESIS,
    'st',
    ...config,
    'run',
    specPath,
    '--url',
    svc.env.baseUrl,
    ...headers.flatMap((header) => ['--header', header]),
    '--checks',
    'all',
    ...(cfg.excludeChecks?.length ? ['--exclude-checks', cfg.excludeChecks.map((c) => c.check).join(',')] : []),
    ...readOnly,
    '--max-examples',
    String(cfg.maxExamples ?? 25),
    '--seed',
    String(cfg.seed ?? 20261029),
    '--report',
    'junit',
    '--report-junit-path',
    resolve(outDir, 'junit.xml'),
    '--report-allure-path',
    resolve(reportsDir, 'allure-results'),
  ];
  process.stdout.write(`\n== Schemathesis ${mode} as ${user} (${svc.name} ${svc.env.name}) ==\n`);
  const result = spawnSync('uvx', argv, { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
