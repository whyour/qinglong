# crond's supervisor survives the command to publish its actual exit code.
system_receipt_cli="$QL_DIR/static/build/bootstrap/systemCron.js"
if (( ${#BASH_SOURCE[@]} == 1 )); then
  entered=${EPOCHREALTIME:-}
  entered=${entered/./}
  if [[ ! $entered =~ ^[0-9]{13,}$ ]]; then entered="$(date +%s)000"; fi
  export QL_SYSTEM_ENTERED="${entered:0:13}"
  if ! IFS= read -r uuid 2>/dev/null < /proc/sys/kernel/random/uuid; then
    uuid=$(node -p 'require("crypto").randomUUID()') || exit 1
  fi
  export QL_TRIGGER_ID="system-$ID-$uuid"
  # Keep the claim acknowledgement separate from both task output and the
  # exit code: 75 can also be the actual exit code of a launched command.
  {
    claimed=$(exec /bin/bash -c '
      node "$1" start "$ID" "$PPID" "$QL_TRIGGER_ID" "$$" || {
        status=$?; [ "$status" = 75 ] && exit 0; exit "$status"
      }
      echo claimed >&3
      exec 3>&-
      command=$2
      shift 2
      eval "$command"
    ' bash "$system_receipt_cli" "$@" 3>&1 >&4 4>&-)
    status=$?
  } 4>&1
  [[ $claimed == claimed ]] || exit "$status"
  # Capture the command end before launching Node or waiting for a SQLite writer.
  ended=${EPOCHREALTIME:-}
  ended=${ended/./}
  if [[ ! $ended =~ ^[0-9]{13,}$ ]]; then ended="$(date +%s)000"; fi
  while :; do
    node "$system_receipt_cli" finish "$ID" "$$" "$QL_TRIGGER_ID" "$status" "${ended:0:13}" && break
    [[ $? == 75 ]] || break
    sleep 2
  done
  exit "$status"
fi

# Old crontabs enter via task.sh or update.sh. Replay their exact arguments
# through the same supervisor; the exported trigger ID prevents recursion.
exec /bin/bash "${BASH_SOURCE[0]}" 'exec /bin/bash "$@"' "${BASH_SOURCE[1]}" "$@"
