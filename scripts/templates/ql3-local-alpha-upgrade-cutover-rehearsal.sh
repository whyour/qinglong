#!/bin/sh

set -eu

APPLICATION_IMAGE='@@APPLICATION_IMAGE@@'
APPLICATION_ID='@@APPLICATION_ID@@'
OPERATOR_IMAGE='@@OPERATOR_IMAGE@@'
OPERATOR_ID='@@OPERATOR_ID@@'
ARCHITECTURE='@@ARCHITECTURE@@'
SOURCE_REVISION='@@SOURCE_REVISION@@'
ARCHIVE='@@ARCHIVE@@'
VARIANT='@@VARIANT@@'

fail() {
  printf '%s\n' "QingLong Local Alpha cutover rehearsal failed: $*" >&2
  exit 1
}

phase() {
  printf '%s\n' "QingLong Local Alpha cutover phase: $1" >&2
}

usage() {
  printf '%s\n' \
    'usage: sh upgrade-cutover-rehearsal.sh edge|standalone /absolute/legacy-data-root /absolute/new/rehearsal-root <reviewed-sqlite-plan-digest> <reviewed-data-directory-plan-digest> [legacy-container-name] [target-container-name]' >&2
  exit 2
}

valid_digest() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; *) return 0 ;; esac
}

extract_digest() {
  result_file=$1
  field=$2
  value=$(sed -n "s/^.*\"$field\":\"\([0-9a-f][0-9a-f]*\)\".*$/\1/p" "$result_file")
  valid_digest "$value" || fail "$field is missing or invalid in $result_file"
  printf '%s' "$value"
}

container_name() {
  case "$1" in ''|[_.-]*|*[!A-Za-z0-9_.-]*) return 1 ;; *) return 0 ;; esac
}

[ "$#" -ge 5 ] && [ "$#" -le 7 ] || usage
[ "$VARIANT" = headless ] || fail 'cutover rehearsal is available only in the headless Trial Kit'
profile=$1
legacy_root=$2
rehearsal_root=$3
sqlite_plan_digest=$4
directory_plan_digest=$5
legacy_name=${6:-ql3-alpha-upgrade-legacy}
target_name=${7:-ql3-alpha-upgrade-target}

case "$profile" in
  edge) memory=128m; pids=64 ;;
  standalone) memory=256m; pids=256 ;;
  *) usage ;;
esac
container_name "$legacy_name" || fail 'legacy container name is invalid'
container_name "$target_name" || fail 'target container name is invalid'
[ "$legacy_name" != "$target_name" ] || fail 'container names must be distinct'
valid_digest "$sqlite_plan_digest" || fail 'reviewed SQLite plan digest is invalid'
valid_digest "$directory_plan_digest" || fail 'reviewed data-directory plan digest is invalid'
[ "$(uname -s)" = Linux ] || fail 'cutover rehearsal requires a Linux Docker host'
for tool in docker sha256sum grep sed stat date realpath; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
docker_socket=$(realpath /var/run/docker.sock)
[ -S "$docker_socket" ] || fail 'canonical Docker socket is unavailable'
operator_docker_socket=/run/docker.sock

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
(CDPATH= cd -- "$script_dir" && sha256sum --check SHA256SUMS)
docker info >/dev/null 2>&1 || fail 'docker daemon is unavailable'
docker load --input "$script_dir/$ARCHIVE" >/dev/null
application_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$APPLICATION_IMAGE")
operator_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.qinglong.lifecycle"}}|{{index .Config.Labels "io.qinglong.network"}}' "$OPERATOR_IMAGE")
[ "$application_identity" = "$APPLICATION_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION" ] || fail 'application image identity is incompatible'
[ "$operator_identity" = "$OPERATOR_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION|short-lived|none-by-default" ] || fail 'operator image identity is incompatible'
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint /usr/bin/docker \
  "$OPERATOR_IMAGE" --version >/dev/null

[ ! -e "$rehearsal_root" ] || fail 'rehearsal root must not already exist'
sh "$script_dir/upgrade-rehearsal.sh" \
  "$profile" "$legacy_root" "$rehearsal_root" \
  "$sqlite_plan_digest" "$directory_plan_digest"

legacy_sha256=$(sha256sum "$legacy_root/db/database.sqlite" | sed 's/ .*//')
uid=$(id -u)
gid=$(id -g)
[ "$uid" -eq 0 ] && allow_root_service=true || allow_root_service=false
socket_gid=$(stat -c %g "$docker_socket")
old_umask=$(umask)
umask 077
for directory in owner-peppers owner-pepper-backup owner-delivery receipts artifacts plugin-staging plugin-activation service service/cutovers service/cutovers/alpha-upgrade-cutover; do
  [ -d "$rehearsal_root/$directory" ] || mkdir -m 0700 "$rehearsal_root/$directory"
done

run_operator() {
  command_name=$1
  command_file=$2
  result_file=$3
  docker run --rm --read-only --user "$uid:$gid" --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
    --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
    --mount "type=bind,src=$rehearsal_root,dst=$rehearsal_root" \
    "$OPERATOR_IMAGE" "$command_name" run \
    --command-file "$rehearsal_root/commands/$command_file" \
    >"$rehearsal_root/results/$result_file"
}

run_deploy() {
  subcommand=$1
  command_file=$2
  result_file=$3
  docker run --rm --read-only --user "$uid:$gid" \
    --group-add "$socket_gid" --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
    --mount "type=bind,src=$docker_socket,dst=$operator_docker_socket" \
    --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
    --mount "type=bind,src=$rehearsal_root,dst=$rehearsal_root" \
    "$OPERATOR_IMAGE" deploy "$subcommand" \
    --command-file "$rehearsal_root/commands/$command_file" \
    >"$rehearsal_root/results/$result_file"
}

run_deployment_offline() {
  subcommand=$1
  command_file=$2
  result_file=$3
  docker run --rm --read-only --user "$uid:$gid" --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
    --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
    --mount "type=bind,src=$rehearsal_root,dst=$rehearsal_root" \
    "$OPERATOR_IMAGE" deploy "$subcommand" \
    --command-file "$rehearsal_root/commands/$command_file" \
    >"$rehearsal_root/results/$result_file"
}

cat >"$rehearsal_root/commands/setup.json" <<EOF
{"schemaVersion":1,"operation":"local.setup.prepare","options":{"deploymentRoot":"$rehearsal_root","databasePath":"$rehearsal_root/sqlite/qinglong3.sqlite","profile":"$profile","ownerPepperKeyringDirectory":"$rehearsal_root/owner-peppers","ownerPepperBackupDirectory":"$rehearsal_root/owner-pepper-backup","ownerPepperKeyId":"owner-v1","localSecretKeyringPath":"$rehearsal_root/local-secret-keyring.json","busyTimeoutMs":100},"request":{"registerMutationId":"019f8680-143d-4000-8000-000000000111","activateMutationId":"019f8680-143d-4000-8000-000000000112","registeredAtMs":1785254400100,"activatedAtMs":1785254400101}}
EOF
cat >"$rehearsal_root/commands/owner-provision.json" <<EOF
{"schemaVersion":1,"operation":"owner.identity.provision","options":{"deploymentRoot":"$rehearsal_root","databasePath":"$rehearsal_root/sqlite/qinglong3.sqlite","pepperPath":"$rehearsal_root/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"$rehearsal_root/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"mutationId":"019f8680-143d-4000-8000-000000000121","requestId":"alpha-upgrade-owner-provision"}}
EOF
cat >"$rehearsal_root/commands/owner-challenge.json" <<EOF
{"schemaVersion":1,"operation":"owner.challenge.issue","options":{"deploymentRoot":"$rehearsal_root","databasePath":"$rehearsal_root/sqlite/qinglong3.sqlite","pepperPath":"$rehearsal_root/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"$rehearsal_root/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"projectId":"default","mutationId":"019f8680-143d-4000-8000-000000000122","requestId":"alpha-upgrade-owner-challenge"}}
EOF
cat >"$rehearsal_root/commands/owner-claim.json" <<EOF
{"schemaVersion":1,"operation":"owner.claim.from-deliveries","options":{"deploymentRoot":"$rehearsal_root","databasePath":"$rehearsal_root/sqlite/qinglong3.sqlite","pepperPath":"$rehearsal_root/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"$rehearsal_root/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"projectId":"default","mutationId":"019f8680-143d-4000-8000-000000000123","requestId":"alpha-upgrade-owner-claim","credentialMutationId":"019f8680-143d-4000-8000-000000000121","challengeMutationId":"019f8680-143d-4000-8000-000000000122"}}
EOF
cat >"$rehearsal_root/commands/owner-credential-install.json" <<EOF
{"schemaVersion":1,"operation":"owner.credential-presentation.install-from-delivery","options":{"deploymentRoot":"$rehearsal_root","databasePath":"$rehearsal_root/sqlite/qinglong3.sqlite","pepperPath":"$rehearsal_root/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"$rehearsal_root/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"credentialMutationId":"019f8680-143d-4000-8000-000000000121","destinationFilePath":"$rehearsal_root/owner-credential.json"}}
EOF
chmod 0600 "$rehearsal_root/commands"/*.json
phase 'bootstrap Owner authority'
run_operator setup setup.json setup.result.json
run_operator owner owner-provision.json owner-provision.result.json
run_operator owner owner-challenge.json owner-challenge.result.json
run_operator owner owner-claim.json owner-claim.result.json
run_operator owner owner-credential-install.json owner-credential-install.result.json
grep -q '"role":"owner"' "$rehearsal_root/results/owner-claim.result.json" || fail 'Owner claim did not establish owner authority'

directory_manifest_digest=$(extract_digest "$rehearsal_root/stage-summary.json" manifestDigest)
activation_digest=$(extract_digest "$rehearsal_root/stage-summary.json" activationDigest)
cat >"$rehearsal_root/commands/data-directory-transform.json" <<EOF
{"schemaVersion":1,"operation":"local-data-directory.adoption.transform","options":{"deploymentRoot":"$rehearsal_root","dataRoot":"$legacy_root","stagingRoot":"$rehearsal_root/data-directory/staged","transformationRoot":"$rehearsal_root/data-directory/transformation","projectId":"default","profile":"$profile","expectedManifestDigest":"$directory_manifest_digest","sqlite":{"sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","expectedActivationDigest":"$activation_digest"}}}
EOF
chmod 0600 "$rehearsal_root/commands/data-directory-transform.json"
phase 'transform reviewed Legacy data'
run_operator adoption data-directory-transform.json data-directory-transform.result.json
grep -q '"assessment":"ready"' "$rehearsal_root/results/data-directory-transform.result.json" || fail 'data-directory transformation is not ready'
transformation_digest=$(extract_digest "$rehearsal_root/results/data-directory-transform.result.json" transformationDigest)
sed "s/\"operation\":\"local-data-directory.adoption.transform\"/\"operation\":\"local-data-directory.adoption.transform.verify\"/;s/\"sqlite\":{/\"expectedTransformationDigest\":\"$transformation_digest\",\"sqlite\":{/" \
  "$rehearsal_root/commands/data-directory-transform.json" \
  >"$rehearsal_root/commands/data-directory-transform-verify.json"
chmod 0600 "$rehearsal_root/commands/data-directory-transform-verify.json"
run_operator adoption data-directory-transform-verify.json data-directory-transform-verify.result.json
grep -q '"status":"verified"' "$rehearsal_root/results/data-directory-transform-verify.result.json" || fail 'data-directory transformation verification failed'

cleanup_required=1
cleanup() {
  if [ "$cleanup_required" -eq 1 ]; then
    docker rm --force "$target_name" "$legacy_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
legacy_id=$(docker run --detach --name "$legacy_name" --restart no \
  --read-only --user "$uid:$gid" --network none --cap-drop ALL \
  --security-opt no-new-privileges --memory 64m --memory-swap 64m \
  --pids-limit 16 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=4m \
  --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
  --entrypoint /usr/local/bin/node "$OPERATOR_IMAGE" \
  -e 'setInterval(() => {}, 60000)')
[ "${#legacy_id}" -eq 64 ] || fail 'legacy container ID is invalid'
case "$legacy_id" in *[!0-9a-f]*) fail 'legacy container ID is invalid' ;; esac

now_ms=$(($(date +%s) * 1000))
cat >"$rehearsal_root/commands/legacy-stop.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.cutover.legacy-stop","options":{"deploymentRoot":"$rehearsal_root","dockerExecutable":"/usr/bin/docker","dockerSocketPath":"$operator_docker_socket","allowRootService":$allow_root_service},"request":{"cutoverId":"alpha-upgrade-cutover","profile":"$profile","instanceId":"alpha-upgrade","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","legacySourcePath":"$legacy_root/db/database.sqlite","expectedLegacyDatabasePath":"$legacy_root/db/database.sqlite","expectedActivationDigest":"$activation_digest","expectedLegacyContainerId":"$legacy_id","requestedAtMs":$now_ms}}
EOF
chmod 0600 "$rehearsal_root/commands/legacy-stop.json"
phase 'stop exact Legacy container'
run_deploy cutover-legacy-stop legacy-stop.json legacy-stop.result.json
grep -q '"state":"legacy_stopped"' "$rehearsal_root/results/legacy-stop.result.json" || fail 'legacy container did not stop cleanly'
commitment_digest=$(extract_digest "$rehearsal_root/results/legacy-stop.result.json" commitmentDigest)

cat >"$rehearsal_root/commands/data-directory-apply.json" <<EOF
{"schemaVersion":1,"operation":"local-data-directory.adoption.apply","options":{"deploymentRoot":"$rehearsal_root","dataRoot":"$legacy_root","stagingRoot":"$rehearsal_root/data-directory/staged","transformationRoot":"$rehearsal_root/data-directory/transformation","projectId":"default","profile":"$profile","expectedManifestDigest":"$directory_manifest_digest","expectedTransformationDigest":"$transformation_digest","ownerPepperKeyringDirectory":"$rehearsal_root/owner-peppers","credentialFilePath":"$rehearsal_root/owner-credential.json","secretKeyringPath":"$rehearsal_root/local-secret-keyring.json","mutationId":"019f8680-143d-4000-8000-000000000131","failureAuditEventId":"019f8680-143d-4000-8000-000000000132","requestId":"alpha-upgrade-data-apply","sqlite":{"sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","expectedActivationDigest":"$activation_digest"}}}
EOF
chmod 0600 "$rehearsal_root/commands/data-directory-apply.json"
phase 'apply transformed Legacy data'
run_operator adoption data-directory-apply.json data-directory-apply.result.json
grep -q '"status":"committed"' "$rehearsal_root/results/data-directory-apply.result.json" || fail 'authenticated data application did not commit'
commit_digest=$(extract_digest "$rehearsal_root/results/data-directory-apply.result.json" commitDigest)
receipt_digest=$(extract_digest "$rehearsal_root/results/data-directory-apply.result.json" receiptDigest)
sed "s/\"operation\":\"local-data-directory.adoption.apply\"/\"operation\":\"local-data-directory.adoption.apply.verify\"/;s/\"sqlite\":{/\"expectedReceiptDigest\":\"$receipt_digest\",\"sqlite\":{/" \
  "$rehearsal_root/commands/data-directory-apply.json" \
  >"$rehearsal_root/commands/data-directory-apply-verify.json"
chmod 0600 "$rehearsal_root/commands/data-directory-apply-verify.json"
run_operator adoption data-directory-apply-verify.json data-directory-apply-verify.result.json
grep -q '"status":"verified"' "$rehearsal_root/results/data-directory-apply-verify.result.json" || fail 'authenticated data application verification failed'

prepared_ms=$((now_ms + 1))
cat >"$rehearsal_root/commands/adopted-prepare.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.adopted.prepare","options":{"deploymentRoot":"$rehearsal_root","profile":"$profile","instanceId":"alpha-upgrade","busyTimeoutMs":100,"service":{"kind":"docker-target","targetImage":{"authority":"local-image-id","reference":"$APPLICATION_IMAGE","imageId":"$APPLICATION_ID"},"allowRootService":$allow_root_service}},"request":{"bundleId":"019f8680-143d-4000-8000-000000000141","preparedAtMs":$prepared_ms,"cutoverId":"alpha-upgrade-cutover","storage":{"sourcePath":"$legacy_root/db/database.sqlite","targetPath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","expectedActivationDigest":"$activation_digest"},"cutover":{"commitmentPath":"$rehearsal_root/service/cutovers/alpha-upgrade-cutover/0002-legacy-stopped.json","expectedCommitmentDigest":"$commitment_digest"},"legacyDataApplication":{"commitPath":"$rehearsal_root/data-directory/transformation/commit.json","expectedCommitDigest":"$commit_digest","expectedReceiptDigest":"$receipt_digest"}}}
EOF
chmod 0600 "$rehearsal_root/commands/adopted-prepare.json"
phase 'prepare adopted deployment bundle'
run_deployment_offline adopted-prepare adopted-prepare.json adopted-prepare.result.json
grep -q '"status":"prepared"' "$rehearsal_root/results/adopted-prepare.result.json" || fail 'adopted bundle was not prepared'
sed 's/"operation":"local.deployment.adopted.prepare"/"operation":"local.deployment.adopted.verify"/' \
  "$rehearsal_root/commands/adopted-prepare.json" \
  >"$rehearsal_root/commands/adopted-verify.json"
chmod 0600 "$rehearsal_root/commands/adopted-verify.json"
run_deployment_offline adopted-verify adopted-verify.json adopted-verify.result.json
grep -q '"status":"verified"' "$rehearsal_root/results/adopted-verify.result.json" || fail 'adopted bundle verification failed'
bundle_digest=$(extract_digest "$rehearsal_root/results/adopted-verify.result.json" bundleDigest)
grep -Fq "\"reference\": \"$APPLICATION_IMAGE\"" "$rehearsal_root/service/docker-target.json" || fail 'target descriptor image reference drifted'
grep -Fq "\"imageId\": \"$APPLICATION_ID\"" "$rehearsal_root/service/docker-target.json" || fail 'target descriptor image ID drifted'

phase 'create exact target container'
target_id=$(docker create --name "$target_name" --restart no \
  --read-only --user "$uid:$gid" --network none --cap-drop ALL \
  --security-opt no-new-privileges --memory "$memory" --memory-swap "$memory" \
  --cpus 0.5 --pids-limit "$pids" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --mount "type=bind,src=$rehearsal_root,dst=$rehearsal_root" \
  --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly" \
  "$APPLICATION_IMAGE" --config "$rehearsal_root/local-application.json")
[ "${#target_id}" -eq 64 ] || fail 'target container ID is invalid'
case "$target_id" in *[!0-9a-f]*) fail 'target container ID is invalid' ;; esac

start_ms=$((prepared_ms + 1))
cat >"$rehearsal_root/commands/target-start.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.cutover.target-start","options":{"deploymentRoot":"$rehearsal_root","dockerExecutable":"/usr/bin/docker","dockerSocketPath":"$operator_docker_socket","allowRootService":$allow_root_service},"request":{"cutoverId":"alpha-upgrade-cutover","profile":"$profile","instanceId":"alpha-upgrade","activationPath":"$rehearsal_root/sqlite/qinglong3-activation.json","legacySourcePath":"$legacy_root/db/database.sqlite","targetDatabasePath":"$rehearsal_root/sqlite/qinglong3.sqlite","recoveryPath":"$rehearsal_root/sqlite/database.pre-ql3.sqlite","manifestPath":"$rehearsal_root/sqlite/qinglong3-adoption.json","expectedLegacyDatabasePath":"$legacy_root/db/database.sqlite","expectedActivationDigest":"$activation_digest","expectedLegacyCommitmentDigest":"$commitment_digest","expectedLegacyContainerId":"$legacy_id","expectedTargetContainerId":"$target_id","targetImage":{"authority":"local-image-id","reference":"$APPLICATION_IMAGE","imageId":"$APPLICATION_ID"},"applicationConfigPath":"$rehearsal_root/local-application.json","expectedTargetApplicationConfigPath":"$rehearsal_root/local-application.json","expectedTargetCommitmentPath":"$rehearsal_root/service/cutovers/alpha-upgrade-cutover/0002-legacy-stopped.json","generation":1,"requestedAtMs":$start_ms}}
EOF
chmod 0600 "$rehearsal_root/commands/target-start.json"
phase 'start exact target container'
run_deploy cutover-target-start target-start.json target-start.result.json
grep -q '"state":"target_active"' "$rehearsal_root/results/target-start.result.json" || fail 'target did not become active'
stop_ms=$((start_ms + 1))
sed "s/\"operation\":\"local.deployment.cutover.target-start\"/\"operation\":\"local.deployment.cutover.target-stop\"/;s/\"requestedAtMs\":$start_ms/\"requestedAtMs\":$stop_ms/" \
  "$rehearsal_root/commands/target-start.json" \
  >"$rehearsal_root/commands/target-stop.json"
chmod 0600 "$rehearsal_root/commands/target-stop.json"
phase 'stop target and prove rollback candidate'
run_deploy cutover-target-stop target-stop.json target-stop.result.json
grep -q '"reconciliation":"rollback_candidate"' "$rehearsal_root/results/target-stop.result.json" || fail 'target stop did not produce a clean rollback candidate'
[ "$(sha256sum "$legacy_root/db/database.sqlite" | sed 's/ .*//')" = "$legacy_sha256" ] || fail 'legacy database changed during rehearsal'

cat >"$rehearsal_root/cutover-summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-upgrade-cutover-summary@v1","status":"rollback_candidate","profile":"$profile","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","reviewedPlans":{"sqlite":"$sqlite_plan_digest","dataDirectory":"$directory_plan_digest"},"activationDigest":"$activation_digest","transformationDigest":"$transformation_digest","application":{"commitDigest":"$commit_digest","receiptDigest":"$receipt_digest"},"cutover":{"commitmentDigest":"$commitment_digest","bundleDigest":"$bundle_digest","legacyContainerId":"$legacy_id","targetContainerId":"$target_id"},"legacySource":"unchanged","target":"stopped","rollback":"candidate_not_executed"}
EOF
chmod 0600 "$rehearsal_root/cutover-summary.json"
umask "$old_umask"
cleanup_required=0
trap - EXIT HUP INT TERM

printf '%s\n' \
  "QingLong 3.0 isolated cutover rehearsal completed ($profile, $ARCHITECTURE)." \
  "Summary: $rehearsal_root/cutover-summary.json" \
  "Stopped legacy container: $legacy_name ($legacy_id)" \
  "Stopped target container: $target_name ($target_id)" \
  "Remove after review: docker rm $target_name $legacy_name" \
  'The original legacy SQLite remained unchanged. Production cutover and Legacy restart were not authorized.'
