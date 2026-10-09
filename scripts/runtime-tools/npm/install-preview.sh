#!/usr/bin/env bash
set -euo pipefail
payload_dir=$(cd -- "$(dirname -- "$0")" && pwd)
node <<'NODE'
const [major,minor,patch]=process.versions.node.split('.').map(Number);
const supported=(major===22&&(minor>22||(minor===22&&patch>=2)))||(major===24&&minor>=15)||major>=26;
if(!supported)throw new Error('npm12 requires Node ^22.22.2 || ^24.15.0 || >=26.0.0');
NODE
target_dir=${1:?Pass a new /tmp/qinglong-* or /private/tmp/qinglong-* directory}
case "$target_dir" in
  /tmp/qinglong-*|/private/tmp/qinglong-*) ;;
  *) echo 'Refusing a target outside the preview prefix' >&2; exit 1 ;;
esac
if [[ -e "$target_dir" ]]; then
  echo 'Target already exists; use a fresh directory' >&2
  exit 1
fi
mkdir -p "$target_dir"
archive_file="$target_dir/.npm-source.tgz"
if [[ -n "${QL_TOOLS_NPM_ARCHIVE:-}" ]]; then
  cp -- "$QL_TOOLS_NPM_ARCHIVE" "$archive_file"
else
  curl --fail --location --proto '=https' --proto-redir '=https' \
    https://registry.npmjs.org/npm/-/npm-12.2.0.tgz --output "$archive_file"
fi
node - "$payload_dir/source-integrity.json" "$archive_file" <<'NODE'
const fs=require('node:fs');
const crypto=require('node:crypto');
const [manifest,archive]=process.argv.slice(2);
const expected=JSON.parse(fs.readFileSync(manifest,'utf8'));
const actual=crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
if(actual!==expected.sha512Base64)throw new Error('Official npm source SHA512 mismatch');
NODE
tar -xzf "$archive_file" --strip-components=1 -C "$target_dir"
rm -- "$archive_file"
# This directory was created above, solely from the authenticated archive.
# Re-resolve from the recorded lock instead of preserving its stale bundle.
rm -rf -- "$target_dir/node_modules"
cp -- "$payload_dir/package.json" "$target_dir/package.json"
cp -- "$payload_dir/package-lock.json" "$target_dir/package-lock.json"
offline_args=()
if [[ "${QL_TOOLS_OFFLINE:-0}" == 1 ]]; then offline_args+=(--offline); fi
build_cache=${QL_TOOLS_NPM_CACHE:-"$target_dir/.build-cache"}
(
  cd -- "$target_dir"
  NPM_CONFIG_USERCONFIG="$payload_dir/public.npmrc" \
  NPM_CONFIG_CACHE="$build_cache" \
    node "${QL_TOOLS_BOOTSTRAP_NPM:-$(command -v npm)}" ci --os=linux --ignore-scripts --omit=dev --no-audit --no-fund "${offline_args[@]}"
)
if [[ -z "${QL_TOOLS_NPM_CACHE:-}" ]]; then rm -rf -- "$target_dir/.build-cache"; fi
node - "$target_dir" <<'NODE'
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const target=process.argv[2];
const req=createRequire(path.join(target,'package.json'));
const expected={'brace-expansion':'5.0.12','http-cache-semantics':'4.3.0','undici':'6.29.0','tar':'7.5.22'};
const proof={};
for(const [name,version] of Object.entries(expected)){
  const file=req.resolve(name+'/package.json');
  const actual=JSON.parse(fs.readFileSync(file,'utf8')).version;
  if(actual!==version)throw new Error(`${name}: expected ${version}, got ${actual}`);
  proof[name]={version:actual,path:file};
}
fs.writeFileSync(path.join(target,'qinglong-runtime-dependency-proof.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof));
NODE
node "$target_dir/bin/npm-cli.js" --version
