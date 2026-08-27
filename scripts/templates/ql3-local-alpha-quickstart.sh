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
  printf '%s\n' "QingLong Local Alpha quickstart failed: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: sh quickstart.sh edge|standalone /absolute/new/data-root [container-name]' >&2
  exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
profile=$1
data_root=$2
container_name=${3:-ql3-alpha-local}

case "$profile" in
  edge)
    memory=128m
    pids=64
    ;;
  standalone)
    memory=256m
    pids=256
    ;;
  *) usage ;;
esac
case "$VARIANT" in
  headless)
    network_mode=none
    application_config=local-application.json
    ;;
  console)
    [ "$(uname -s)" = Linux ] || fail 'Console variant requires a Linux Docker host'
    network_mode=host
    application_config=local-api.json
    ;;
  *) fail 'embedded Trial Kit variant is invalid' ;;
esac

case "$data_root" in
  /|*[!A-Za-z0-9_./-]*|*'/../'*|*'/./'*|*'/..'|*'/.'|*'//'*|*/)
    fail 'data root must be a canonical absolute path using A-Z, a-z, 0-9, _, ., / or -'
    ;;
  /*) ;;
  *) fail 'data root must be absolute' ;;
esac
case "$container_name" in
  ''|[_.-]*|*[!A-Za-z0-9_.-]*) fail 'container name is invalid' ;;
esac

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command -v grep >/dev/null 2>&1 || fail 'grep is required'

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
parent=${data_root%/*}
[ -n "$parent" ] || parent=/
[ -d "$parent" ] || fail 'data root parent does not exist'
parent_real=$(CDPATH= cd -- "$parent" && pwd -P)
[ "$parent_real/${data_root##*/}" = "$data_root" ] || fail 'data root parent is not canonical'
[ ! -e "$data_root" ] || fail 'data root must not already exist'

(CDPATH= cd -- "$script_dir" && sha256sum --check SHA256SUMS)
docker info >/dev/null 2>&1 || fail 'docker daemon is unavailable'
docker load --input "$script_dir/$ARCHIVE" >/dev/null

application_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$APPLICATION_IMAGE")
operator_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.qinglong.lifecycle"}}|{{index .Config.Labels "io.qinglong.network"}}' "$OPERATOR_IMAGE")
[ "$application_identity" = "$APPLICATION_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION" ] || fail 'application image identity is incompatible'
[ "$operator_identity" = "$OPERATOR_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION|short-lived|none-by-default" ] || fail 'operator image identity is incompatible'

old_umask=$(umask)
umask 077
mkdir -m 0700 "$data_root"
for directory in owner-peppers owner-pepper-backup owner-delivery receipts artifacts plugin-staging plugin-activation results; do
  mkdir -m 0700 "$data_root/$directory"
done

cat >"$data_root/setup.json" <<EOF
{"schemaVersion":1,"operation":"local.setup.prepare","options":{"deploymentRoot":"/var/lib/qinglong3","databasePath":"/var/lib/qinglong3/qinglong3.sqlite","profile":"$profile","ownerPepperKeyringDirectory":"/var/lib/qinglong3/owner-peppers","ownerPepperBackupDirectory":"/var/lib/qinglong3/owner-pepper-backup","ownerPepperKeyId":"owner-v1","localSecretKeyringPath":"/var/lib/qinglong3/local-secret-keyring.json","busyTimeoutMs":100},"request":{"registerMutationId":"019f8680-143d-4000-8000-000000000011","activateMutationId":"019f8680-143d-4000-8000-000000000012","registeredAtMs":1785254400000,"activatedAtMs":1785254400001}}
EOF
cat >"$data_root/owner-provision.json" <<EOF
{"schemaVersion":1,"operation":"owner.identity.provision","options":{"deploymentRoot":"/var/lib/qinglong3","databasePath":"/var/lib/qinglong3/qinglong3.sqlite","pepperPath":"/var/lib/qinglong3/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"/var/lib/qinglong3/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"mutationId":"019f8680-143d-4000-8000-000000000021","requestId":"alpha-trial-owner-provision"}}
EOF
cat >"$data_root/owner-challenge.json" <<EOF
{"schemaVersion":1,"operation":"owner.challenge.issue","options":{"deploymentRoot":"/var/lib/qinglong3","databasePath":"/var/lib/qinglong3/qinglong3.sqlite","pepperPath":"/var/lib/qinglong3/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"/var/lib/qinglong3/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"projectId":"default","mutationId":"019f8680-143d-4000-8000-000000000022","requestId":"alpha-trial-owner-challenge"}}
EOF
cat >"$data_root/owner-claim.json" <<EOF
{"schemaVersion":1,"operation":"owner.claim.from-deliveries","options":{"deploymentRoot":"/var/lib/qinglong3","databasePath":"/var/lib/qinglong3/qinglong3.sqlite","pepperPath":"/var/lib/qinglong3/owner-peppers/b3duZXItdjE.pepper","pepperKeyId":"owner-v1","secretDeliveryDirectory":"/var/lib/qinglong3/owner-delivery","profile":"$profile","busyTimeoutMs":100},"request":{"projectId":"default","mutationId":"019f8680-143d-4000-8000-000000000023","requestId":"alpha-trial-owner-claim","credentialMutationId":"019f8680-143d-4000-8000-000000000021","challengeMutationId":"019f8680-143d-4000-8000-000000000022"}}
EOF
cat >"$data_root/local-application.json" <<EOF
{"schema":"qinglong/local-application-process@v2","instanceId":"alpha-trial-local","profile":"$profile","storage":{"mode":"fresh","databasePath":"/var/lib/qinglong3/qinglong3.sqlite","busyTimeoutMs":100},"runtime":{"receiptRoot":"/var/lib/qinglong3/receipts","artifactRoot":"/var/lib/qinglong3/artifacts","secretKeyringPath":"/var/lib/qinglong3/local-secret-keyring.json"},"pluginPackages":{"stagingRoot":"/var/lib/qinglong3/plugin-staging","activationRoot":"/var/lib/qinglong3/plugin-activation","recoverySource":{"mode":"disabled"},"pageSize":4,"maxPages":4,"taskPublicationPageSize":4,"taskPublicationMaxPages":4},"ai":{"deployment":"excluded"}}
EOF
if [ "$VARIANT" = console ]; then
  cat >"$data_root/local-api.json" <<EOF
{"schema":"qinglong/local-api-process@v1","deploymentRoot":"/var/lib/qinglong3","applicationConfigFilePath":"/var/lib/qinglong3/local-application.json","ownerPepperKeyringDirectory":"/var/lib/qinglong3/owner-peppers","listener":{"host":"127.0.0.1","port":5700}}
EOF
fi
chmod 0600 "$data_root"/*.json

uid=$(id -u)
gid=$(id -g)
run_operator() {
  command_name=$1
  command_file=$2
  docker run --rm --read-only --user "$uid:$gid" --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
    --mount "type=bind,src=$data_root,dst=/var/lib/qinglong3" \
    "$OPERATOR_IMAGE" "$command_name" run \
    --command-file "/var/lib/qinglong3/$command_file" \
    >"$data_root/results/$command_file.result.json"
}

run_operator setup setup.json
grep -q '"status":"prepared"' "$data_root/results/setup.json.result.json" || fail 'fresh setup did not report prepared'
run_operator owner owner-provision.json
grep -q '"status":"inserted"' "$data_root/results/owner-provision.json.result.json" || fail 'Owner credential provisioning did not report inserted'
run_operator owner owner-challenge.json
grep -q '"status":"inserted"' "$data_root/results/owner-challenge.json.result.json" || fail 'Owner challenge did not report inserted'
run_operator owner owner-claim.json
grep -q '"status":"inserted"' "$data_root/results/owner-claim.json.result.json" || fail 'Owner claim did not report inserted'
grep -q '"role":"owner"' "$data_root/results/owner-claim.json.result.json" || fail 'Owner claim did not establish the owner role'

ready=0
cleanup() {
  if [ "$ready" -ne 1 ]; then
    docker rm --force "$container_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

container_id=$(docker run --detach --name "$container_name" \
  --restart unless-stopped --read-only --user "$uid:$gid" --network "$network_mode" \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory "$memory" --memory-swap "$memory" --cpus 0.5 --pids-limit "$pids" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --mount "type=bind,src=$data_root,dst=/var/lib/qinglong3" \
  "$APPLICATION_IMAGE" --config "/var/lib/qinglong3/$application_config")
printf '%s\n' "$container_id" >"$data_root/container.id"
chmod 0600 "$data_root/container.id"

attempt=0
while [ "$attempt" -lt 45 ]; do
  if docker logs "$container_name" 2>&1 | grep -q '"event":"active"'; then
    ready=1
    break
  fi
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  [ "$running" = true ] || fail 'application stopped before becoming active'
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || fail 'application did not become active within 45 seconds'
umask "$old_umask"

printf '%s\n' \
  "QingLong 3.0 Local Alpha is active ($VARIANT, $profile, $ARCHITECTURE)." \
  "Data root: $data_root" \
  "Owner deliveries: $data_root/owner-delivery" \
  "Logs: docker logs $container_name" \
  "Stop: docker stop --time 30 $container_name" \
  "Remove container: docker rm $container_name" \
  'The fresh data root is retained until you remove it explicitly.'
if [ "$VARIANT" = console ]; then
  printf '%s\n' \
    'Console: http://127.0.0.1:5700/' \
    'Remote access: create an SSH tunnel to 127.0.0.1:5700; do not expose the port on LAN or the public Internet.'
fi
