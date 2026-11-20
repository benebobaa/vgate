# Releasing vgate

A release is built locally, checked by a dry run, and uploaded to the Cloudflare R2 bucket `vgate-releases`, which is
served at `https://vgate.benelabs.tech`. The name, the URL, the bucket and the platforms live in one file,
`cli/release-config.ts`; `scripts/install.sh` repeats the name and the URL, and the release script refuses to publish
when they disagree.

## Bucket layout

```
install.sh                 the installer             Cache-Control: public, max-age=300
latest                     the current version       public, max-age=60
latest.json                { name, version, manifest }  public, max-age=60
v<version>/
  vgate-<version>-<platform>.tar.gz   one per platform: the binary and LICENSE     immutable, one year
  SHA256SUMS                          checksums of the archives                     immutable
  SHA256SUMS.minisig                  signature, when the release is signed         immutable
  manifest.json                       platforms, files, sizes, checksums            immutable
```

Platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`.

## 1. Build

```bash
# bump "version" in package.json first: a published version is never overwritten
pnpm task release:build          # = bun cli/build.ts --all
```

It compiles every platform with Bun (darwin binaries get an ad-hoc signature when built on macOS, which Apple Silicon
requires), packs each into a tar.gz, and writes `SHA256SUMS`, `manifest.json`, `latest`, `latest.json` and a copy of
`install.sh`. `dist/release/` is laid out exactly like the bucket, so serving it locally tests the installer:

```bash
python3 -m http.server 8765 --directory dist/release &
curl -fsSL http://127.0.0.1:8765/install.sh | VGATE_BASE_URL=http://127.0.0.1:8765 VGATE_INSTALL_DIR=/tmp/vgate-test sh
```

Every release is signed: build with `VGATE_MINISIGN_KEY` set to the minisign secret key, which lives outside the
repository (the maintainer's copy: `~/.config/vgate/minisign.key`, mode 600; keep a backup somewhere safe). The build
writes `SHA256SUMS.minisig`; `scripts/release.ts` refuses to publish without it, or when it does not verify against
`minisign.pub`, or when `install.sh`'s default key differs. Rotating the key means a new `minisign.pub`, the new key in
`install.sh`, and a release.

## 2. Dry run

```bash
pnpm task release:dry-run        # = pnpm exec tsx scripts/release.ts
```

It verifies the build (every platform present, every archive matches its manifest checksum, `latest` names this
version, `install.sh` matches `scripts/install.sh` and `cli/release-config.ts`) and lists every object with its
content type and cache policy. It contacts nothing and needs no credentials.

## 3. Publish

```bash
export CLOUDFLARE_API_TOKEN=...      # an API token with R2 edit permission on the account
export CLOUDFLARE_ACCOUNT_ID=...
pnpm exec tsx scripts/release.ts --publish [--bucket vgate-releases]
```

Credentials are read from the environment only. wrangler runs in an empty temporary directory with only those
variables, so no `wrangler.toml`, `.env` or `.dev.vars` in a working copy can redirect the upload.

The script first checks that `v<version>/manifest.json` is not already in the bucket (releases are immutable; a
failed check stops it before it writes), then uploads the archives, the checksums, the signature and the manifest,
and only then `install.sh`, `latest.json` and `latest`. A half-finished upload never moves `latest`; re-running after
a failure is safe as long as the manifest was not uploaded (delete the partial `v<version>/` objects otherwise).

### Alternative: the S3 API

R2 speaks the S3 API at `https://<account id>.r2.cloudflarestorage.com`. With an R2 access key pair (R2 > Manage API
tokens) in the environment, any S3 client works, e.g. the AWS CLI, keeping the same order and headers:

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=auto
R2="--endpoint-url https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"
v=0.6.3
aws s3 cp dist/release/v$v/ s3://vgate-releases/v$v/ --recursive --exclude manifest.json \
  --cache-control 'public, max-age=31536000, immutable' $R2
aws s3 cp dist/release/v$v/manifest.json s3://vgate-releases/v$v/manifest.json \
  --content-type application/json --cache-control 'public, max-age=31536000, immutable' $R2
aws s3 cp dist/release/install.sh s3://vgate-releases/install.sh \
  --content-type 'text/plain; charset=utf-8' --cache-control 'public, max-age=300' $R2
aws s3 cp dist/release/latest.json s3://vgate-releases/latest.json \
  --content-type application/json --cache-control 'public, max-age=60' $R2
aws s3 cp dist/release/latest s3://vgate-releases/latest \
  --content-type 'text/plain; charset=utf-8' --cache-control 'public, max-age=60' $R2
```

This path does not check for an existing version: run `aws s3 ls s3://vgate-releases/v$v/ $R2` first.

## What the owner provides once

| Item            | Where                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The bucket      | R2 > Create bucket `vgate-releases`                                                                                                   |
| Public access   | Bucket > Settings > Custom domain `vgate.benelabs.tech` (the `benelabs.tech` zone is in the account); keep the r2.dev URL off         |
| An API token    | My Profile > API Tokens: R2 edit on the account, for `--publish`                                                                      |
| The signing key | `minisign -G` on a trusted machine; the secret key never enters the repository; for `release.yml`, secret `VGATE_MINISIGN_SECRET_KEY` |
| The license     | `LICENSE` (Apache-2.0) at the repository root; the build packs it into every tarball                                                  |

After the first publish, check from a clean machine:

```bash
curl -fsSI https://vgate.benelabs.tech/latest.json
curl -fsSL https://vgate.benelabs.tech/install.sh | sh && vgate version
```
