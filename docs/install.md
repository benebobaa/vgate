# Installing vgate

vgate is one binary for macOS and Linux (x64 and arm64; musl builds for Alpine). Releases are served from
`https://vgate.benelabs.tech`.

## Install

```bash
curl -fsSL https://vgate.benelabs.tech/install.sh | sh
```

The script detects the OS, the architecture and the C library, downloads the release, verifies its SHA-256 checksum
against the release's `SHA256SUMS`, and installs `vgate` into `~/.local/bin` (or `/usr/local/bin` when `~/.local/bin`
cannot be written and `/usr/local/bin` can). It never calls `sudo`; it refuses to install anything it could not
verify. If the directory is not on your `PATH`, it prints the line to add.

| Variable                | Default                       | Meaning                                                     |
| ----------------------- | ----------------------------- | ----------------------------------------------------------- |
| `VGATE_VERSION`         | the latest release            | The version to install, e.g. `0.1.1`                        |
| `VGATE_INSTALL_DIR`     | `~/.local/bin`                | Where the binary goes                                       |
| `VGATE_BASE_URL`        | `https://vgate.benelabs.tech` | Where releases are served from (a mirror, or a local test)  |
| `VGATE_MINISIGN_PUBKEY` | none                          | Verify the signature of `SHA256SUMS` too (needs `minisign`) |

On Alpine and other musl distributions the binary needs the C++ runtime: `apk add libstdc++ libgcc`. The installer
says so when the installed binary does not start.

Then: `vgate doctor` checks that the machine can run the gate and names the fix for everything it cannot.

## Pin a version

A project pins the version it is verified with in `vgate.yaml` (`version: 0.1.1`), and its CI installs exactly that
one:

```bash
curl -fsSL https://vgate.benelabs.tech/install.sh | VGATE_VERSION=0.1.1 sh
```

Releases are immutable: `0.1.1` is the same bytes forever. Only `latest` moves.

## Verify by hand

```bash
v=0.1.1; f=vgate-$v-linux-x64.tar.gz
curl -fsSLO https://vgate.benelabs.tech/v$v/$f
curl -fsSLO https://vgate.benelabs.tech/v$v/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS        # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
```

A checksum proves the download is the file the release lists; it does not prove who published the release. Once
releases are signed, also verify `SHA256SUMS.minisig` with the published public key:
`minisign -Vm SHA256SUMS -P <public key>`.

Every release also carries `v<version>/manifest.json` (platforms, sizes, checksums), and `latest.json` names the
current version.

## Uninstall

```bash
rm "$(command -v vgate)"
rm -rf ~/.cache/vgate        # the framework runtime vgate unpacks per version
```
