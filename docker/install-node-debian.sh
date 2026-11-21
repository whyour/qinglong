#!/bin/sh
set -eu

# The official Node 24 Bookworm image does not cover s390x. Use the same
# verified upstream release archive on every supported Debian architecture.
version=24.22.3
case "${1:?Missing Docker TARGETARCH}" in
  amd64) arch=x64; checksum=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
  arm64) arch=arm64; checksum=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;;
  ppc64le) arch=ppc64le; checksum=c4b446699171f64763304a0bc6fb972b0fb4acb1de5358e52b4c52a95883593a ;;
  s390x) arch=s390x; checksum=b5dbeb563ffb81946478fd765ae92efc21117e410e4e9b7d966bf59b00cee55d ;;
  *) echo "Node ${version} has no supported Debian binary for TARGETARCH=$1" >&2; exit 1 ;;
esac

archive="node-v${version}-linux-${arch}.tar.xz"
curl --fail --location --silent --show-error --retry 3 \
  "https://nodejs.org/dist/v${version}/${archive}" -o "/tmp/${archive}"
printf '%s  %s\n' "${checksum}" "/tmp/${archive}" | sha256sum --check --status
tar -xJf "/tmp/${archive}" -C /usr/local --strip-components=1 --no-same-owner
rm "/tmp/${archive}"
# The target binary is executed and version-checked in the target builder/runtime stages.
test -x /usr/local/bin/node
