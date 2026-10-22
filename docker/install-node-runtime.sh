#!/bin/sh
set -eu

# Official binaries, pinned to their release checksums. Node 24 no longer
# publishes ARMv7 binaries, so that existing Debian target uses Node 22 LTS.
node_version=24.18.1
case "${TARGETARCH:?}/${TARGETVARIANT:-}" in
  amd64/*) node_arch=x64; node_sha=d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0 ;;
  arm64/*) node_arch=arm64; node_sha=7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c ;;
  ppc64le/*) node_arch=ppc64le; node_sha=c47812c13862be7f6e71194c434c4d78a99096e72efb9c31a2627437e056d669 ;;
  s390x/*) node_arch=s390x; node_sha=acf57bd726f35afc2ba8475194e5a8bd532c00e1a3b2436295b2fbdde199d0e9 ;;
  arm/v7) node_version=22.23.2; node_arch=armv7l; node_sha=ef8f26a3de19acd8c23548e6c3cfc2052610b0e67abb5fd64dbd92c8b1c1245b ;;
  *) echo "Unsupported Debian Node architecture: ${TARGETARCH}/${TARGETVARIANT:-}" >&2; exit 1 ;;
esac

if [ "${1:-}" = --print ]; then
  printf '%s %s %s\n' "$node_version" "$node_arch" "$node_sha"
  exit 0
fi

node_prefix=${1:-/usr/local}
node_work_dir=$(mktemp -d)
trap 'rm -rf "$node_work_dir"' EXIT
node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 \
  "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "$node_work_dir/$node_archive"
printf '%s  %s\n' "$node_sha" "$node_work_dir/$node_archive" | sha256sum -c -
mkdir -p "$node_prefix"
tar -xJf "$node_work_dir/$node_archive" -C "$node_prefix" --strip-components=1 --no-same-owner
"$node_prefix/bin/node" -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); try {db.exec("CREATE TABLE node_probe(value INTEGER);INSERT INTO node_probe VALUES(42)");if(db.prepare("SELECT value FROM node_probe").get().value!==42)throw Error("Node SQLite probe failed");}finally{db.close();}'
