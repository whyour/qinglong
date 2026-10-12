#!/usr/bin/env bash
set -euo pipefail
scripts_dir=$(cd -- "$(dirname -- "$0")" && pwd)
payload_dir="$scripts_dir/runtime-tools"
output_dir=${1:?Pass a fresh output directory}
case "$output_dir" in /*) ;; *) echo 'Output directory must be absolute' >&2; exit 1 ;; esac
if [[ -e "$output_dir" ]]; then echo 'Output directory already exists' >&2; exit 1; fi
if [[ "$(node --version)" != v22.23.3 ]]; then echo 'Build requires Node22.23.3' >&2; exit 1; fi
if [[ "$(uname -s)" != Linux && "${QL_TOOLS_ALLOW_HOST_SMOKE:-0}" != 1 ]]; then echo 'Release artifact must be built on Linux' >&2; exit 1; fi
source_commit=${QL_TOOLS_SOURCE_COMMIT:?Set the Qinglong source commit}
if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then echo 'Source commit must be a full Git SHA' >&2; exit 1; fi
node "$scripts_dir/verify-runtime-tools-source.cjs" "$payload_dir" "$source_commit"
build_dir=$(mktemp -d /tmp/qinglong-runtime-build.XXXXXX)
build_dir=$(cd -- "$build_dir" && pwd -P)
cleanup() { rm -rf -- "$build_dir"; }
trap cleanup EXIT
bootstrap_npm=${QL_TOOLS_BOOTSTRAP_NPM:-"$(dirname -- "$(command -v node)")/../lib/node_modules/npm/bin/npm-cli.js"}
export QL_TOOLS_BOOTSTRAP_NPM="$bootstrap_npm"
export QL_TOOLS_NPM_CACHE=${QL_TOOLS_NPM_CACHE:-"$build_dir/npm-cache"}
export NODE_COMPILE_CACHE="$build_dir/compile-cache"
export NPM_CONFIG_GLOBALCONFIG=/dev/null
bash "$payload_dir/npm/install-preview.sh" "$build_dir/npm"
export QL_TOOLS_BOOTSTRAP_NPM="$build_dir/npm/bin/npm-cli.js"
bash "$payload_dir/pnpm-source/build-preview.sh" "$build_dir/pnpm-build"
mkdir "$build_dir/tools-payload"
cp -- "$payload_dir/tools/package.json" "$payload_dir/tools/package-lock.json" \
  "$payload_dir/tools/public.npmrc" "$payload_dir/tools/install-preview.sh" "$build_dir/tools-payload/"
cp -- "$build_dir/pnpm-build/pnpm-10.34.6-qinglong-security-linux.tgz" "$build_dir/tools-payload/"
bash "$build_dir/tools-payload/install-preview.sh" "$build_dir/tools"
mkdir "$build_dir/tools/bin"
cp -- "$payload_dir/pnpm-wrapper.cjs" "$build_dir/tools/bin/pnpm.cjs"
chmod 755 "$build_dir/tools/bin/pnpm.cjs"
node "$scripts_dir/pack-runtime-tools.cjs" --npm "$build_dir/npm" --tools "$build_dir/tools" \
  --payload "$payload_dir" --output "$output_dir" --source-commit "$source_commit"
