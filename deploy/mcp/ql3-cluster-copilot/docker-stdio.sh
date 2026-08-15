#!/bin/sh

set -eu

usage() {
  printf '%s\n' 'Usage: docker-stdio.sh check|serve' >&2
  exit 64
}

fail() {
  printf '%s\n' '{"schemaVersion":1,"component":"qinglong3-cluster-copilot-mcp-launcher","event":"launch_failed"}' >&2
  exit 78
}

[ "$#" -eq 1 ] || usage
mode=$1
case "$mode" in
  check|serve) ;;
  *) usage ;;
esac

image=${QL3_COPILOT_MCP_IMAGE-}
private_root=${QL3_COPILOT_MCP_PRIVATE_ROOT-}
network=${QL3_COPILOT_MCP_NETWORK-}
resource_class=${QL3_COPILOT_MCP_RESOURCE_CLASS-compact}

printf '%s' "$image" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}@sha256:[0-9a-f]{64}$' || fail
printf '%s' "$network" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' || fail
case "$network" in
  bridge|default|host|none) fail ;;
esac
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
    concurrency_ceiling=1
    ;;
  standard)
    memory=512m
    cpus=1
    pids=64
    concurrency_ceiling=4
    ;;
  dense)
    memory=1g
    cpus=2
    pids=96
    concurrency_ceiling=16
    ;;
  *) fail ;;
esac

set -- docker run --rm -i --pull never --init --read-only \
  --network "$network" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 10001:10001 \
  --pids-limit "$pids" \
  --memory "$memory" \
  --cpus "$cpus" \
  --mount "type=bind,src=$private_root,dst=/var/run/secrets/qinglong3/copilot-mcp,readonly" \
  "$image" \
  copilot-mcp

if [ "$mode" = check ]; then
  exec "$@" --check --config /var/run/secrets/qinglong3/copilot-mcp/mcp.json \
    "--concurrency-ceiling=$concurrency_ceiling"
fi

exec "$@" --config /var/run/secrets/qinglong3/copilot-mcp/mcp.json \
  "--concurrency-ceiling=$concurrency_ceiling"
