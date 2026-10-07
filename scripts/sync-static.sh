#!/usr/bin/env bash
# Static branches are orphan snapshots. Fetch complete commits for the branch
# that was built: a shallow/default-branch clone is rejected by mirror servers.
set -euo pipefail
destination=$1
branch=$2
ref_type=${3:-branch}
git check-ref-format "refs/heads/$branch"
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
git init --bare "$workspace"
fetch_refs=("+refs/heads/$branch:refs/heads/$branch")
push_refs=("refs/heads/$branch:refs/heads/$branch")
if [[ "$ref_type" == 'tag' ]]; then
  fetch_refs+=("+refs/tags/$branch:refs/tags/$branch")
  push_refs+=("refs/tags/$branch:refs/tags/$branch")
fi
git -C "$workspace" fetch --no-tags "${QL_STATIC_SOURCE:-https://github.com/whyour/qinglong-static.git}" \
  "${fetch_refs[@]}"
git -C "$workspace" push --force "$destination" "${push_refs[@]}"
