#!/usr/bin/env bash
set -euo pipefail
payload_dir=$(cd -- "$(dirname -- "$0")" && pwd)
target_dir=${1:?Pass a fresh /tmp/qinglong-* or /private/tmp/qinglong-* build directory}
case "$target_dir" in /tmp/qinglong-*|/private/tmp/qinglong-*) ;; *) echo 'Target outside preview prefix' >&2; exit 1 ;; esac
if [[ -e "$target_dir" ]]; then echo 'Target already exists' >&2; exit 1; fi
if [[ "$(node --version)" != v22.23.3 ]]; then echo 'This reviewed build pins Node v22.23.3' >&2; exit 1; fi
npm_cli=${QL_TOOLS_BOOTSTRAP_NPM:?Pass the reviewed npm12 bin/npm-cli.js}
if [[ "$(node "$npm_cli" --version)" != 12.2.0 ]]; then echo 'This reviewed build pins npm12.2.0' >&2; exit 1; fi
mkdir -p "$target_dir/source" "$target_dir/bootstrap"
if [[ -n "${QL_TOOLS_PNPM_SOURCE_ARCHIVE:-}" ]]; then
  cp -- "$QL_TOOLS_PNPM_SOURCE_ARCHIVE" "$target_dir/source.tgz"
else
  curl --fail --location --proto '=https' --proto-redir '=https' \
    https://codeload.github.com/pnpm/pnpm/tar.gz/9287c31cea69206c4eeca7f21cd21df81d0b93e7 --output "$target_dir/source.tgz"
fi
if [[ -n "${QL_TOOLS_PNPM_BOOTSTRAP_ARCHIVE:-}" ]]; then
  cp -- "$QL_TOOLS_PNPM_BOOTSTRAP_ARCHIVE" "$target_dir/bootstrap.tgz"
else
  curl --fail --location --proto '=https' --proto-redir '=https' \
    https://registry.npmjs.org/pnpm/-/pnpm-10.34.6.tgz --output "$target_dir/bootstrap.tgz"
fi
node - "$payload_dir" "$target_dir" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [payload,target]=process.argv.slice(2);
for(const [metadata,archive,algorithm,encoding,key] of [
  ['source-integrity.json','source.tgz','sha256','hex','sha256'],
  ['bootstrap-integrity.json','bootstrap.tgz','sha512','base64','sha512Base64'],
]){
  const pin=JSON.parse(fs.readFileSync(path.join(payload,metadata),'utf8'));
  const actual=crypto.createHash(algorithm).update(fs.readFileSync(path.join(target,archive))).digest(encoding);
  if(actual!==pin[key])throw new Error(archive+' integrity mismatch');
}
NODE
tar -xzf "$target_dir/source.tgz" --strip-components=1 -C "$target_dir/source"
tar -xzf "$target_dir/bootstrap.tgz" --strip-components=1 -C "$target_dir/bootstrap"
cp -- "$payload_dir/pnpm-workspace.yaml" "$target_dir/source/pnpm-workspace.yaml"
cp -- "$payload_dir/pnpm-lock.yaml" "$target_dir/source/pnpm-lock.yaml"
offline_args=()
if [[ "${QL_TOOLS_OFFLINE:-0}" == 1 ]]; then offline_args+=(--offline); fi
export NPM_CONFIG_USERCONFIG="$payload_dir/public.npmrc"
export NPM_CONFIG_CACHE=${QL_TOOLS_NPM_CACHE:-"$target_dir/npm-cache"}
export PNPM_HOME="$target_dir/pnpm-home"
export NODE_COMPILE_CACHE="$target_dir/node-compile-cache"
unset NODE_PATH
pnpm_store=${QL_TOOLS_PNPM_STORE:-"$target_dir/pnpm-store"}
node "$target_dir/bootstrap/bin/pnpm.cjs" --dir "$target_dir/source" \
  --filter pnpm... --filter monorepo-root install --frozen-lockfile --ignore-scripts \
  --store-dir "$pnpm_store" --config.manage-package-manager-versions=false \
  --config.package-manager-strict=false --config.cache-dir="$target_dir/pnpm-cache" \
  --config.state-dir="$target_dir/pnpm-state" "${offline_args[@]}"
cmp -- "$payload_dir/pnpm-lock.yaml" "$target_dir/source/pnpm-lock.yaml"
(
  cd -- "$target_dir/source/pnpm"
  node ../node_modules/typescript/bin/tsc --build
)
node "$payload_dir/bundle-linux.cjs" "$target_dir/source" "$target_dir/package/dist"
cp -- "$payload_dir/node-gyp-runtime/package.json" "$target_dir/package/dist/package.json"
cp -- "$payload_dir/node-gyp-runtime/package-lock.json" "$target_dir/package/dist/package-lock.json"
(
  cd -- "$target_dir/package/dist"
  node "$npm_cli" ci --ignore-scripts --omit=dev --no-audit --no-fund "${offline_args[@]}"
)
cmp -- "$payload_dir/node-gyp-runtime/package-lock.json" "$target_dir/package/dist/package-lock.json"
python3 "$payload_dir/assemble-and-pack.py" "$target_dir/source" "$target_dir/package" \
  "$target_dir/pnpm-10.34.6-qinglong-security-linux.tgz" "$payload_dir"
(
  cd -- "$target_dir"
  node "$target_dir/package/bin/pnpm.cjs" --config.manage-package-manager-versions=false --version
  node "$target_dir/package/dist/node_modules/node-gyp/bin/node-gyp.js" --version
)
