#!/bin/sh
# Installs the vgate CLI: downloads the release for this OS and architecture, verifies its SHA-256 checksum and, when
# minisign is installed, the release's signature of those checksums, and puts the binary
# in a directory on your PATH. It never calls sudo.
#
#   curl -fsSL https://vgate.benelabs.tech/install.sh | sh
#   curl -fsSL https://vgate.benelabs.tech/install.sh | VGATE_VERSION=0.6.1 sh
#
# Environment:
#   VGATE_VERSION          version to install (default: the latest release)
#   VGATE_INSTALL_DIR      where to put the binary (default: ~/.local/bin; /usr/local/bin when that is not
#                          writable but /usr/local/bin is)
#   VGATE_BASE_URL         where releases are served from
#   VGATE_MINISIGN_PUBKEY  another minisign public key (the base64 line) to verify SHA256SUMS against
set -eu

# Kept in step with NAME and BASE_URL in cli/release-config.ts (scripts/release.ts refuses a mismatch).
NAME=vgate
BASE_URL="${VGATE_BASE_URL:-https://vgate.benelabs.tech}"
# The release signing key (minisign.pub in the repository, docs/install.md). Releases from 0.6.0 on are signed: with
# minisign installed, a missing or wrong signature refuses the install. Releases made before signing are listed below.
PUBKEY="${VGATE_MINISIGN_PUBKEY:-RWQi+ioDcIKPgRudn0qWcaeiayx8ZecM+sYU5HFz9LL3oTe/HlX2Ux3g}"
UNSIGNED_RELEASES=" 0.1.2 0.2.0 0.2.1 0.3.0 0.4.0 0.5.0 "

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) fail "unsupported operating system: $(uname -s) (releases exist for macOS and Linux)" ;;
  esac
}

detect_arch() {
  machine=$(uname -m)
  case "$machine" in
    x86_64 | amd64)
      # An x64 shell on Apple Silicon runs under Rosetta: install the native build instead.
      if [ "$1" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        echo arm64
      else
        echo x64
      fi
      ;;
    arm64 | aarch64) echo arm64 ;;
    *) fail "unsupported architecture: $machine (releases exist for x64 and arm64)" ;;
  esac
}

is_musl() {
  if ls /lib/ld-musl-* >/dev/null 2>&1; then return 0; fi
  ldd --version 2>&1 | grep -qi musl
}

fetch() { # <url> <output file>
  if command -v curl >/dev/null 2>&1; then
    # A CI runner's network blips (connection reset, 5xx): retry every error a few times before giving up.
    curl -fsSL --retry 4 --retry-all-errors --retry-delay 2 --connect-timeout 20 -o "$2" "$1" ||
      fail "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=5 --waitretry=2 -O "$2" "$1" || fail "download failed: $1"
  else
    fail "neither curl nor wget is installed"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else
    fail "no SHA-256 tool (sha256sum, shasum or openssl): refusing to install an unverified binary"
  fi
}

pick_dir() {
  if [ -n "${VGATE_INSTALL_DIR:-}" ]; then
    mkdir -p "$VGATE_INSTALL_DIR" 2>/dev/null || fail "cannot create VGATE_INSTALL_DIR=$VGATE_INSTALL_DIR"
    [ -w "$VGATE_INSTALL_DIR" ] || fail "VGATE_INSTALL_DIR=$VGATE_INSTALL_DIR is not writable"
    echo "$VGATE_INSTALL_DIR"
    return
  fi
  default="${HOME:-}/.local/bin"
  if [ -n "${HOME:-}" ] && mkdir -p "$default" 2>/dev/null && [ -w "$default" ]; then
    echo "$default"
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    echo /usr/local/bin
  else
    fail "no writable install directory: set VGATE_INSTALL_DIR, or run this script with sudo yourself"
  fi
}

main() {
  os=$(detect_os)
  arch=$(detect_arch "$os")
  platform="$os-$arch"
  if [ "$os" = linux ] && is_musl; then platform="$platform-musl"; fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t vgate)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  version="${VGATE_VERSION:-}"
  if [ -z "$version" ]; then
    fetch "$BASE_URL/latest" "$tmp/latest"
    version=$(tr -d ' \r\n' <"$tmp/latest")
  fi
  version=${version#v}
  case "$version" in
    '' | *[!0-9A-Za-z.-]*) fail "not a version: '$version'" ;;
  esac

  file="$NAME-$version-$platform.tar.gz"
  say "Installing $NAME $version ($platform) from $BASE_URL"
  fetch "$BASE_URL/v$version/SHA256SUMS" "$tmp/SHA256SUMS"
  fetch "$BASE_URL/v$version/$file" "$tmp/$file"

  case "$UNSIGNED_RELEASES" in
    *" $version "*)
      say "$NAME $version predates release signing: the checksum is verified, there is no signature"
      PUBKEY=""
      ;;
  esac
  if [ -n "$PUBKEY" ]; then
    if command -v minisign >/dev/null 2>&1; then
      fetch "$BASE_URL/v$version/SHA256SUMS.minisig" "$tmp/SHA256SUMS.minisig"
      minisign -Vqm "$tmp/SHA256SUMS" -P "$PUBKEY" -x "$tmp/SHA256SUMS.minisig" ||
        fail "the signature of SHA256SUMS does not verify: refusing to install"
      say "Signature verified"
    else
      say "minisign is not installed: the checksum is verified, the signature is not"
    fi
  fi

  expected=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "$file is not listed in SHA256SUMS of $version (is $platform released?)"
  actual=$(sha256_of "$tmp/$file")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $file (expected $expected, got $actual): refusing to install"

  mkdir "$tmp/x"
  tar -xzf "$tmp/$file" -C "$tmp/x" || fail "could not unpack $file"
  [ -f "$tmp/x/$NAME" ] || fail "$file holds no $NAME binary"

  dir=$(pick_dir)
  # Copy beside the target, then rename: a running vgate is never replaced by a half-written file.
  cp "$tmp/x/$NAME" "$dir/.$NAME.tmp.$$"
  chmod 755 "$dir/.$NAME.tmp.$$"
  mv -f "$dir/.$NAME.tmp.$$" "$dir/$NAME"

  if ! installed=$("$dir/$NAME" version 2>/dev/null); then
    case "$platform" in
      *-musl) fail "installed $dir/$NAME, but it does not start: musl builds need the C++ runtime (apk add libstdc++ libgcc)" ;;
      *) fail "installed $dir/$NAME, but it does not start; run it by hand to see why" ;;
    esac
  fi
  say "Installed $dir/$NAME ($installed)"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "Add it to your PATH:  export PATH=\"$dir:\$PATH\"" ;;
  esac
  say "Next: $NAME doctor"
}

main "$@"
