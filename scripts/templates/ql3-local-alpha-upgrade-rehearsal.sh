#!/bin/sh

set -eu

OPERATOR_IMAGE='@@OPERATOR_IMAGE@@'
OPERATOR_ID='@@OPERATOR_ID@@'
ARCHITECTURE='@@ARCHITECTURE@@'
SOURCE_REVISION='@@SOURCE_REVISION@@'
ARCHIVE='@@ARCHIVE@@'

fail() {
  printf '%s\n' "QingLong Local Alpha upgrade rehearsal failed: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: sh upgrade-rehearsal.sh edge|standalone /absolute/legacy-data-root /absolute/new/rehearsal-root <reviewed-sqlite-plan-digest> <reviewed-data-directory-plan-digest>' >&2
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

valid_digest() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
    *) return 0 ;;
  esac
}

extract_digest() {
  result_file=$1
  field=$2
  digest=$(sed -n "s/^.*\"$field\":\"\([0-9a-f][0-9a-f]*\)\".*$/\1/p" "$result_file")
  valid_digest "$digest" || fail "$field is missing or invalid in $result_file"
  printf '%s' "$digest"
}

[ "$#" -eq 5 ] || usage
profile=$1
legacy_root=$2
rehearsal_root=$3
sqlite_plan_digest=$4
directory_plan_digest=$5

case "$profile" in
  edge|standalone) ;;
  *) usage ;;
esac
safe_absolute_path "$legacy_root" || fail 'legacy data root is not a safe canonical absolute path'
safe_absolute_path "$rehearsal_root" || fail 'rehearsal root is not a safe canonical absolute path'
valid_digest "$sqlite_plan_digest" || fail 'reviewed SQLite plan digest is invalid'
valid_digest "$directory_plan_digest" || fail 'reviewed data-directory plan digest is invalid'
[ "$legacy_root" != "$rehearsal_root" ] || fail 'legacy and rehearsal roots must be distinct'
case "$rehearsal_root/" in
  "$legacy_root"/*) fail 'rehearsal root must not be inside the legacy data root' ;;
esac
case "$legacy_root/" in
  "$rehearsal_root"/*) fail 'legacy data root must not be inside the rehearsal root' ;;
esac
[ -d "$legacy_root" ] || fail 'legacy data root does not exist'
[ -f "$legacy_root/db/database.sqlite" ] || fail 'legacy db/database.sqlite does not exist'
legacy_real=$(CDPATH= cd -- "$legacy_root" && pwd -P)
[ "$legacy_real" = "$legacy_root" ] || fail 'legacy data root is not canonical'
[ ! -e "$rehearsal_root" ] || fail 'rehearsal root must not already exist'
rehearsal_parent=${rehearsal_root%/*}
[ -n "$rehearsal_parent" ] || rehearsal_parent=/
[ -d "$rehearsal_parent" ] || fail 'rehearsal root parent does not exist'
rehearsal_parent_real=$(CDPATH= cd -- "$rehearsal_parent" && pwd -P)
[ "$rehearsal_parent_real/${rehearsal_root##*/}" = "$rehearsal_root" ] || fail 'rehearsal root parent is not canonical'

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command -v grep >/dev/null 2>&1 || fail 'grep is required'
command -v sed >/dev/null 2>&1 || fail 'sed is required'

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
(CDPATH= cd -- "$script_dir" && sha256sum --check SHA256SUMS)
docker info >/dev/null 2>&1 || fail 'docker daemon is unavailable'
docker load --input "$script_dir/$ARCHIVE" >/dev/null

operator_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.qinglong.lifecycle"}}|{{index .Config.Labels "io.qinglong.network"}}' "$OPERATOR_IMAGE")
[ "$operator_identity" = "$OPERATOR_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION|short-lived|none-by-default" ] || fail 'operator image identity is incompatible'

old_umask=$(umask)
umask 077
mkdir -m 0700 "$rehearsal_root"
for directory in commands results sqlite data-directory; do
  mkdir -m 0700 "$rehearsal_root/$directory"
done

cat >"$rehearsal_root/commands/sqlite-stage.json" <<EOF
{"schemaVersion":1,"operation":"local-sqlite.adoption.stage","options":{"deploymentRoot":"$rehearsal_root","profile":"$profile","sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","expectedPlanDigest":"$sqlite_plan_digest"}}
EOF
cat >"$rehearsal_root/commands/sqlite-verify.json" <<EOF
{"schemaVersion":1,"operation":"local-sqlite.adoption.verify","options":{"deploymentRoot":"$rehearsal_root","profile":"$profile","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json"}}
EOF
chmod 0600 "$rehearsal_root/commands/sqlite-stage.json" "$rehearsal_root/commands/sqlite-verify.json"

uid=$(id -u)
gid=$(id -g)
run_adoption() {
  command_file=$1
  result_file=$2
  docker run --rm --read-only --user "$uid:$gid" --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
    --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
    --mount "type=bind,src=$rehearsal_root,dst=$rehearsal_root" \
    "$OPERATOR_IMAGE" adoption run \
    --command-file "$rehearsal_root/commands/$command_file" \
    >"$rehearsal_root/results/$result_file"
}

run_adoption sqlite-stage.json sqlite-stage.result.json
grep -q '"status":"staged"' "$rehearsal_root/results/sqlite-stage.result.json" || fail 'SQLite stage did not report staged'
run_adoption sqlite-verify.json sqlite-verify.result.json
grep -q '"status":"verified"' "$rehearsal_root/results/sqlite-verify.result.json" || fail 'SQLite verify did not report verified'
sqlite_manifest_digest=$(extract_digest "$rehearsal_root/results/sqlite-verify.result.json" manifestDigest)

cat >"$rehearsal_root/commands/sqlite-activation.json" <<EOF
{"schemaVersion":1,"operation":"local-sqlite.activation.prepare","options":{"deploymentRoot":"$rehearsal_root","profile":"$profile","sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","expectedManifestDigest":"$sqlite_manifest_digest"}}
EOF
chmod 0600 "$rehearsal_root/commands/sqlite-activation.json"
run_adoption sqlite-activation.json sqlite-activation.result.json
grep -q '"status":"prepared"' "$rehearsal_root/results/sqlite-activation.result.json" || fail 'SQLite activation did not report prepared'
activation_digest=$(extract_digest "$rehearsal_root/results/sqlite-activation.result.json" activationDigest)

cat >"$rehearsal_root/commands/data-directory-stage.json" <<EOF
{"schemaVersion":1,"operation":"local-data-directory.adoption.stage","options":{"deploymentRoot":"$rehearsal_root","dataRoot":"$legacy_root","stagingRoot":"$rehearsal_root/data-directory/staged","profile":"$profile","expectedPlanDigest":"$directory_plan_digest","sqlite":{"sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","expectedActivationDigest":"$activation_digest"}}}
EOF
chmod 0600 "$rehearsal_root/commands/data-directory-stage.json"
run_adoption data-directory-stage.json data-directory-stage.result.json
grep -q '"status":"staged"' "$rehearsal_root/results/data-directory-stage.result.json" || fail 'data-directory stage did not report staged'
directory_manifest_digest=$(extract_digest "$rehearsal_root/results/data-directory-stage.result.json" manifestDigest)

cat >"$rehearsal_root/commands/data-directory-verify.json" <<EOF
{"schemaVersion":1,"operation":"local-data-directory.adoption.verify","options":{"deploymentRoot":"$rehearsal_root","dataRoot":"$legacy_root","stagingRoot":"$rehearsal_root/data-directory/staged","profile":"$profile","expectedManifestDigest":"$directory_manifest_digest","sqlite":{"sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","expectedActivationDigest":"$activation_digest"}}}
EOF
chmod 0600 "$rehearsal_root/commands/data-directory-verify.json"
run_adoption data-directory-verify.json data-directory-verify.result.json
grep -q '"status":"verified"' "$rehearsal_root/results/data-directory-verify.result.json" || fail 'data-directory verify did not report verified'

cat >"$rehearsal_root/stage-summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-upgrade-stage-summary@v1","status":"verified","profile":"$profile","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","reviewedPlans":{"sqlite":"$sqlite_plan_digest","dataDirectory":"$directory_plan_digest"},"sqlite":{"manifestDigest":"$sqlite_manifest_digest","activationDigest":"$activation_digest"},"dataDirectory":{"manifestDigest":"$directory_manifest_digest"},"legacySource":"read_only","cutover":"not_authorized"}
EOF
chmod 0600 "$rehearsal_root/stage-summary.json"
umask "$old_umask"

printf '%s\n' \
  "QingLong 2.x side-by-side upgrade stage completed ($profile, $ARCHITECTURE)." \
  "Stage summary: $rehearsal_root/stage-summary.json" \
  "SQLite activation evidence: $rehearsal_root/sqlite/qinglong3-activation.json" \
  "Data-directory manifest: $rehearsal_root/data-directory/staged/manifest.json" \
  'The legacy root remained read-only. No transform/apply, target start, cutover or Legacy rollback was authorized.' \
  'Preserve the complete rehearsal root. Do not edit or reuse it as a production data root.'
