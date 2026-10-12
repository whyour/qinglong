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
if [[ -e "$target_dir" ]]; then echo 'Target already exists; use a fresh directory' >&2; exit 1; fi
mkdir -p "$target_dir"
cp -- "$payload_dir/package.json" "$target_dir/package.json"
cp -- "$payload_dir/package-lock.json" "$target_dir/package-lock.json"
cp -- "$payload_dir/pnpm-10.34.6-qinglong-security-linux.tgz" "$target_dir/pnpm-10.34.6-qinglong-security-linux.tgz"
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
const expected={'pnpm':'10.34.6','pm2':'7.0.4','node-gyp':'12.4.0','ts-node':'10.9.2','typescript':'5.9.3'};
const proof={};
for(const [name,version] of Object.entries(expected)){
  const file=path.join(target,'node_modules',name,'package.json');
  const actual=JSON.parse(fs.readFileSync(file,'utf8')).version;
  if(actual!==version)throw new Error(`${name}: expected ${version}, got ${actual}`);
  proof[name]={version:actual,path:file};
}
const pm2Req=createRequire(path.join(target,'node_modules/pm2/package.json'));
for(const [name,version] of Object.entries({'js-yaml':'4.3.2','basic-ftp':'6.2.1'})){
  const file=pm2Req.resolve(name+'/package.json');
  const actual=JSON.parse(fs.readFileSync(file,'utf8')).version;
  if(actual!==version)throw new Error(`PM2 ${name}: expected ${version}, got ${actual}`);
  proof[`pm2/${name}`]={version:actual,path:file};
}
const pnpmDistReq=createRequire(path.join(target,'node_modules/pnpm/dist/package.json'));
for(const [name,version] of Object.entries({'node-gyp':'12.4.0','tar':'7.5.22'})){
  const file=pnpmDistReq.resolve(name+'/package.json');
  const actual=JSON.parse(fs.readFileSync(file,'utf8')).version;
  if(actual!==version)throw new Error(`PNPM default ${name}: expected ${version}, got ${actual}`);
  proof[`pnpm-default/${name}`]={version:actual,path:file};
}
fs.writeFileSync(path.join(target,'qinglong-runtime-tools-proof.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof));
NODE
