#!/bin/sh

set -eu

usage() {
  printf '%s\n' 'Usage: docker-loopback.sh check|serve' >&2
  exit 64
}

fail() {
  printf '%s\n' '{"schemaVersion":1,"component":"qinglong3-cluster-copilot-console-launcher","event":"launch_failed"}' >&2
  exit 78
}

[ "$#" -eq 1 ] || usage
mode=$1
case "$mode" in
  check|serve) ;;
  *) usage ;;
esac

image=${QL3_COPILOT_CONSOLE_IMAGE-}
private_root=${QL3_COPILOT_CONSOLE_PRIVATE_ROOT-}
network=${QL3_COPILOT_CONSOLE_NETWORK-}
port=${QL3_COPILOT_CONSOLE_PORT-}
resource_class=${QL3_COPILOT_CONSOLE_RESOURCE_CLASS-compact}
run_management=${QL3_COPILOT_CONSOLE_RUN_MANAGEMENT-disabled}
worker_management=${QL3_COPILOT_CONSOLE_WORKER_MANAGEMENT-disabled}
package_management=${QL3_COPILOT_CONSOLE_PACKAGE_MANAGEMENT-disabled}

printf '%s' "$image" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}@sha256:[0-9a-f]{64}$' || fail
printf '%s' "$network" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' || fail
case "$network" in
  bridge|default|host|none) fail ;;
esac
printf '%s' "$port" | grep -Eq '^[1-9][0-9]{3,4}$' || fail
[ "$port" -ge 1024 ] 2>/dev/null || fail
[ "$port" -le 65535 ] 2>/dev/null || fail
case "$private_root" in
  /*) ;;
  *) fail ;;
esac
case "$private_root" in
  *','*|*':'*) fail ;;
esac
[ -d "$private_root" ] || fail
canonical_root=$(CDPATH= cd -- "$private_root" 2>/dev/null && pwd -P) || fail
[ "$canonical_root" = "$private_root" ] || fail

case "$resource_class" in
  compact)
    memory=192m
    cpus=0.25
    pids=32
    ;;
  standard)
    memory=512m
    cpus=1
    pids=64
    ;;
  *) fail ;;
esac
case "$run_management" in
  disabled|enabled) ;;
  *) fail ;;
esac
case "$worker_management" in
  disabled|enabled) ;;
  *) fail ;;
esac
case "$package_management" in
  disabled|enabled) ;;
  *) fail ;;
esac

set -- docker run --rm --pull never --init --read-only \
  --network "$network" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 10001:10001 \
  --pids-limit "$pids" \
  --memory "$memory" \
  --cpus "$cpus" \
  --stop-timeout 3 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001 \
  --mount "type=bind,src=$private_root,dst=/var/run/secrets/qinglong3/copilot-console,readonly"

if [ "$mode" = serve ]; then
  set -- "$@" --publish "127.0.0.1:$port:$port/tcp"
fi

set -- "$@" "$image" copilot-console \
  --container-published-loopback \
  "--port=$port" \
  --config /var/run/secrets/qinglong3/copilot-console/client.json \
  --credential /var/run/secrets/qinglong3/copilot-console/credential \
  --session /var/run/secrets/qinglong3/copilot-console/session

if [ "$run_management" = enabled ]; then
  set -- "$@" \
    --run-management-config /var/run/secrets/qinglong3/copilot-console/run-management-client.json \
    --run-management-assertion /var/run/secrets/qinglong3/copilot-console/run-management-assertion.jwt
fi

if [ "$worker_management" = enabled ]; then
  set -- "$@" \
    --worker-management-config /var/run/secrets/qinglong3/copilot-console/worker-management-client.json \
    --worker-management-assertion /var/run/secrets/qinglong3/copilot-console/worker-management-assertion.jwt
fi

if [ "$package_management" = enabled ]; then
  set -- "$@" \
    --package-management-config /var/run/secrets/qinglong3/copilot-console/package-management-client.json \
    --package-management-assertion /var/run/secrets/qinglong3/copilot-console/package-management-assertion.jwt
fi

if [ "$mode" = check ]; then
  set -- "$@" --check
fi

exec "$@"
