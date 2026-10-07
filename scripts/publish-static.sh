#!/usr/bin/env bash
set -euo pipefail
destination=$1
ref=$2
ref_type=$3
git check-ref-format "refs/heads/$ref"
script_dir=$(cd "$(dirname "$0")" && pwd)
# Publish only a complete artifact from the checked-out source commit.
node "$script_dir/../docker/verify-build.cjs"
if [[ "$ref_type" == 'tag' ]]; then
  version=$(awk '$1 == "version:" { print $2; exit }' version.yaml)
  if [[ "$ref" != "v$version" ]]; then
    echo "::error::Release tag $ref does not match version.yaml ($version)"
    exit 1
  fi
elif [[ "$ref_type" != 'branch' ]]; then
  echo "::error::Unsupported ref type: $ref_type"
  exit 1
fi
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
cp -a static/. "$workspace/"
git init -b "$ref" "$workspace"
git -C "$workspace" config user.name 'github-actions[bot]'
git -C "$workspace" config user.email 'github-actions[bot]@users.noreply.github.com'
git -C "$workspace" add -f .
git -C "$workspace" commit --allow-empty -m "Build static from $(git rev-parse HEAD)"
refs=("refs/heads/$ref:refs/heads/$ref")
if [[ "$ref_type" == 'tag' ]]; then
  # Keep version branches for existing archive URLs and publish real Git tags.
  git -C "$workspace" tag "$ref"
  refs+=("refs/tags/$ref:refs/tags/$ref")
fi
git -C "$workspace" push --force --quiet "$destination" "${refs[@]}"
