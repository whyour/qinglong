#!/bin/sh

set -eu

OPERATOR_IMAGE='@@OPERATOR_IMAGE@@'
OPERATOR_ID='@@OPERATOR_ID@@'
ARCHITECTURE='@@ARCHITECTURE@@'
SOURCE_REVISION='@@SOURCE_REVISION@@'
ARCHIVE='@@ARCHIVE@@'

fail() {
  printf '%s\n' "QingLong Local Alpha upgrade readiness failed: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: sh upgrade-readiness.sh edge|standalone /absolute/legacy-data-root /absolute/new/evidence-root' >&2
  exit 2
}

safe_absolute_path() {
  case "$1" in
    /|*[!A-Za-z0-9_./-]*|*'/../'*|*'/./'*|*'/..'|*'/.'|*'//'*|*/)
      return 1
      ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}

[ "$#" -eq 3 ] || usage
profile=$1
legacy_root=$2
evidence_root=$3

case "$profile" in
  edge|standalone) ;;
  *) usage ;;
esac
safe_absolute_path "$legacy_root" || fail 'legacy data root is not a safe canonical absolute path'
safe_absolute_path "$evidence_root" || fail 'evidence root is not a safe canonical absolute path'
[ "$legacy_root" != "$evidence_root" ] || fail 'legacy and evidence roots must be distinct'
[ -d "$legacy_root" ] || fail 'legacy data root does not exist'
[ -f "$legacy_root/db/database.sqlite" ] || fail 'legacy db/database.sqlite does not exist'
legacy_real=$(CDPATH= cd -- "$legacy_root" && pwd -P)
[ "$legacy_real" = "$legacy_root" ] || fail 'legacy data root is not canonical'
[ ! -e "$evidence_root" ] || fail 'evidence root must not already exist'
evidence_parent=${evidence_root%/*}
[ -n "$evidence_parent" ] || evidence_parent=/
[ -d "$evidence_parent" ] || fail 'evidence root parent does not exist'
evidence_parent_real=$(CDPATH= cd -- "$evidence_parent" && pwd -P)
[ "$evidence_parent_real/${evidence_root##*/}" = "$evidence_root" ] || fail 'evidence root parent is not canonical'

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command -v grep >/dev/null 2>&1 || fail 'grep is required'

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
(CDPATH= cd -- "$script_dir" && sha256sum --check SHA256SUMS)
docker info >/dev/null 2>&1 || fail 'docker daemon is unavailable'
docker load --input "$script_dir/$ARCHIVE" >/dev/null

operator_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.qinglong.lifecycle"}}|{{index .Config.Labels "io.qinglong.network"}}' "$OPERATOR_IMAGE")
[ "$operator_identity" = "$OPERATOR_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION|short-lived|none-by-default" ] || fail 'operator image identity is incompatible'

old_umask=$(umask)
umask 077
mkdir -m 0700 "$evidence_root"
mkdir -m 0700 "$evidence_root/results"

cat >"$evidence_root/sqlite-inspect.json" <<EOF
{"schemaVersion":1,"operation":"local-sqlite.adoption.inspect","options":{"deploymentRoot":"/var/lib/qinglong3","profile":"$profile","sourcePath":"$legacy_root/db/database.sqlite"}}
EOF
cat >"$evidence_root/data-directory-inspect.json" <<EOF
{"schemaVersion":1,"operation":"local-data-directory.adoption.inspect","options":{"dataRoot":"$legacy_root","profile":"$profile"}}
EOF
chmod 0600 "$evidence_root/sqlite-inspect.json" "$evidence_root/data-directory-inspect.json"

uid=$(id -u)
gid=$(id -g)
run_inspect() {
  command_file=$1
  result_file=$2
  result_stage="$evidence_root/results/.$result_file.$$"
  attempt=1
  while [ "$attempt" -le 2 ]; do
    if docker run --rm --read-only --user "$uid:$gid" --network none \
      --cap-drop ALL --security-opt no-new-privileges \
      --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
      --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
      --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
      --mount "type=bind,src=$evidence_root,dst=/var/lib/qinglong3" \
      "$OPERATOR_IMAGE" adoption run \
      --command-file "/var/lib/qinglong3/$command_file" \
      >"$result_stage"
    then
      chmod 0600 "$result_stage"
      mv "$result_stage" "$evidence_root/results/$result_file"
      return 0
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

run_inspect sqlite-inspect.json sqlite-inspect.result.json
grep -q '"status":"inspected"' "$evidence_root/results/sqlite-inspect.result.json" || fail 'SQLite inspect did not report inspected'
run_inspect data-directory-inspect.json data-directory-inspect.result.json
grep -q '"status":"inspected"' "$evidence_root/results/data-directory-inspect.result.json" || fail 'data-directory inspect did not report inspected'

umask "$old_umask"
printf '%s\n' \
  "QingLong 2.x upgrade readiness inspection completed ($profile, $ARCHITECTURE)." \
  "SQLite plan: $evidence_root/results/sqlite-inspect.result.json" \
  "Data-directory plan: $evidence_root/results/data-directory-inspect.result.json" \
  'The legacy data root was mounted read-only; no stage, activation, cutover or rollback was authorized.' \
  'Review both complete results and preserve their exact plan digests before any later rehearsal phase.'
