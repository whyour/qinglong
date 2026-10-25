#!/bin/sh
set -eu

# The official Node 24 Bookworm image does not cover s390x. Use the same
# verified upstream release archive on every supported Debian architecture.
version=24.18.1
case "${1:?Missing Docker TARGETARCH}" in
  amd64) arch=x64; checksum=d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0 ;;
  arm64) arch=arm64; checksum=7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c ;;
  ppc64le) arch=ppc64le; checksum=c47812c13862be7f6e71194c434c4d78a99096e72efb9c31a2627437e056d669 ;;
  s390x) arch=s390x; checksum=acf57bd726f35afc2ba8475194e5a8bd532c00e1a3b2436295b2fbdde199d0e9 ;;
  *) echo "Node ${version} has no supported Debian binary for TARGETARCH=$1" >&2; exit 1 ;;
esac

archive="node-v${version}-linux-${arch}.tar.xz"
curl --fail --location --silent --show-error --retry 3 \
  "https://nodejs.org/dist/v${version}/${archive}" -o "/tmp/${archive}"
printf '%s  %s\n' "${checksum}" "/tmp/${archive}" | sha256sum --check --status
tar -xJf "/tmp/${archive}" -C /usr/local --strip-components=1 --no-same-owner
rm "/tmp/${archive}"
test "$(node --version)" = "v${version}"
