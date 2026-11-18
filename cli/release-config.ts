/**
 * The public identity of a release: the CLI's name, where releases are served from, and the platforms built for.
 * One place, so the build, the release upload, the installer's defaults and the CLI's own version check agree.
 *
 * Bucket layout (served at BASE_URL, the bucket's custom domain):
 *   install.sh  latest  latest.json          at the root, short cache
 *   v<version>/<asset>.tar.gz SHA256SUMS[.minisig] manifest.json   immutable
 * Renaming the CLI is a one-line edit of NAME here plus NAME in scripts/install.sh.
 */

/** The binary's name and the prefix of every release asset. */
export const NAME = 'vgate';

/** Public URL of the release bucket (R2 bucket `vgate-releases` behind a custom domain). */
export const BASE_URL = 'https://vgate.benelabs.tech';

/** Object key prefix inside the bucket; empty: install.sh and latest.json sit at the root. */
export const BUCKET_PREFIX = '';

/** The R2 bucket the release script uploads to unless told otherwise. */
export const BUCKET = 'vgate-releases';

/** `v0.2.0`: the directory (and key prefix) of one release. */
export function versionDir(version: string): string {
  return `v${version}`;
}

export interface Platform {
  os: 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  /** Linux C library; musl builds run on Alpine and other musl distributions. */
  libc?: 'musl';
  /** Bun's --compile target. */
  bunTarget: string;
}

/** Every platform a release carries. Windows is not built: the stacks are bash and Docker Compose. */
export const PLATFORMS: Platform[] = [
  { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64' },
  { os: 'darwin', arch: 'x64', bunTarget: 'bun-darwin-x64' },
  { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64' },
  { os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64' },
  { os: 'linux', arch: 'x64', libc: 'musl', bunTarget: 'bun-linux-x64-musl' },
  { os: 'linux', arch: 'arm64', libc: 'musl', bunTarget: 'bun-linux-arm64-musl' },
];

/** `darwin-arm64`, `linux-x64-musl`: the platform part of an asset name, as scripts/install.sh computes it. */
export function platformId(platform: Pick<Platform, 'os' | 'arch' | 'libc'>): string {
  return [platform.os, platform.arch, platform.libc].filter(Boolean).join('-');
}

/** `vgate-0.2.0-linux-x64.tar.gz` */
export function assetName(version: string, platform: Pick<Platform, 'os' | 'arch' | 'libc'>): string {
  return `${NAME}-${version}-${platformId(platform)}.tar.gz`;
}

/** Semver without a leading v, optionally with a pre-release. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
