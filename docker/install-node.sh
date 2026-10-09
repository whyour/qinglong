#!/bin/sh
set -eu

# These release files are committed together so every target architecture uses
# the same official Node release and authenticated checksum list.
NODE_VERSION=22.23.3
NODE_SIGNER=5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
case "${TARGETARCH:?}/${TARGETVARIANT:-}" in
  amd64/) NODE_ARCH=x64 ;;
  arm/v7) NODE_ARCH=armv7l ;;
  arm64/|arm64/v8) NODE_ARCH=arm64 ;;
  ppc64le/) NODE_ARCH=ppc64le ;;
  s390x/) NODE_ARCH=s390x ;;
  *) printf 'Unsupported Debian Node architecture: %s/%s\n' "$TARGETARCH" "${TARGETVARIANT:-}" >&2; exit 1 ;;
esac

DOWNLOAD_DIR=$(mktemp -d)
KEY_DIR=$(mktemp -d)
trap 'rm -rf "$DOWNLOAD_DIR" "$KEY_DIR"' EXIT HUP INT TERM
chmod 700 "$KEY_DIR"
gpg --homedir "$KEY_DIR" --batch --import /tmp/node-release-key.asc
FINGERPRINT=$(gpg --homedir "$KEY_DIR" --batch --with-colons --fingerprint "$NODE_SIGNER" | awk -F: '$1 == "fpr" { print $10; exit }')
test "$FINGERPRINT" = "$NODE_SIGNER"
gpg --homedir "$KEY_DIR" --batch --status-fd 3 --output "$DOWNLOAD_DIR/SHASUMS256.txt" \
  --decrypt "/tmp/node-v${NODE_VERSION}-SHASUMS256.txt.asc" 3> "$DOWNLOAD_DIR/signature.status"
grep -q "^\[GNUPG:\] VALIDSIG ${NODE_SIGNER} " "$DOWNLOAD_DIR/signature.status"

NODE_FILE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
cd "$DOWNLOAD_DIR"
grep "  ${NODE_FILE}$" SHASUMS256.txt > expected.sha256
test "$(wc -l < expected.sha256 | tr -d ' ')" = 1
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_FILE}" --output "$NODE_FILE"
sha256sum --check --strict expected.sha256
mkdir -p /opt/node-target
tar --extract --xz --file "$NODE_FILE" --directory /opt/node-target --strip-components=1
test -x /opt/node-target/bin/node
test -f /opt/node-target/lib/node_modules/npm/package.json
