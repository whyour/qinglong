#!/bin/sh

# QingLong 3.0 durable local-process launcher. It is a POSIX wrapper rather
# than a per-task Node sidecar, and publishes exactly one immutable receipt.
set -u
umask 077

launch_mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

run_id=${QL3_RECEIPT_RUN_ID-}
attempt_id=${QL3_RECEIPT_ATTEMPT_ID-}
callback_sequence=${QL3_RECEIPT_CALLBACK_SEQUENCE-}
callback_token=${QL3_RECEIPT_CALLBACK_TOKEN-}
started_at_ms=${QL3_RECEIPT_STARTED_AT_MS-}
receipt_target=${QL3_RECEIPT_TARGET-}
receipt_temporary=${QL3_RECEIPT_TEMPORARY-}
launch_shell=${QL3_LAUNCH_SHELL-}
launch_shell_command=${QL3_LAUNCH_SHELL_COMMAND-}
output_quota_fifo=${QL3_OUTPUT_QUOTA_FIFO-}
output_quota_remaining_bytes=${QL3_OUTPUT_QUOTA_REMAINING_BYTES-}
output_artifact_id=${QL3_OUTPUT_ARTIFACT_ID-}
output_maximum_bytes=${QL3_OUTPUT_MAXIMUM_BYTES-}
output_truncation_target=${QL3_OUTPUT_TRUNCATION_TARGET-}
output_truncation_temporary=${QL3_OUTPUT_TRUNCATION_TEMPORARY-}

# The user process must never inherit the callback capability or receipt paths.
unset QL3_RECEIPT_RUN_ID QL3_RECEIPT_ATTEMPT_ID
unset QL3_RECEIPT_CALLBACK_SEQUENCE QL3_RECEIPT_CALLBACK_TOKEN
unset QL3_RECEIPT_STARTED_AT_MS QL3_RECEIPT_TARGET QL3_RECEIPT_TEMPORARY
unset QL3_LAUNCH_SHELL QL3_LAUNCH_SHELL_COMMAND
unset QL3_OUTPUT_QUOTA_FIFO QL3_OUTPUT_QUOTA_REMAINING_BYTES
unset QL3_OUTPUT_ARTIFACT_ID QL3_OUTPUT_MAXIMUM_BYTES
unset QL3_OUTPUT_TRUNCATION_TARGET QL3_OUTPUT_TRUNCATION_TEMPORARY

case "$callback_sequence" in
  ''|*[!0-9]*) exit 125 ;;
esac
case "$started_at_ms" in
  ''|*[!0-9]*) exit 125 ;;
esac
if [ -z "$run_id" ] || [ -z "$attempt_id" ] || [ -z "$callback_token" ] ||
  [ -z "$receipt_target" ] || [ -z "$receipt_temporary" ]; then
  exit 125
fi
if ! { [ "$launch_mode" = "argv" ] && [ "$#" -gt 0 ]; } &&
  ! { [ "$launch_mode" = "shell" ] && [ -n "$launch_shell" ]; }; then
  exit 125
fi

drain_pid=
if [ -n "$output_quota_fifo" ]; then
  case "$output_quota_remaining_bytes" in
    ''|*[!0-9]*) exit 125 ;;
  esac
  case "$output_maximum_bytes" in
    ''|*[!0-9]*) exit 125 ;;
  esac
  if [ -z "$output_artifact_id" ] ||
    [ -z "$output_truncation_target" ] ||
    [ -z "$output_truncation_temporary" ]; then
    exit 125
  fi
  # Use each supported Linux userspace's byte-exact, streaming copy primitive.
  # GNU dd counts short reads as blocks even with count_bytes; do not use it.
  # BusyBox head can read ahead past the quota; do not use it either.
  if command -v busybox >/dev/null 2>&1 &&
    busybox dd bs=16384 count=0 iflag=count_bytes status=none </dev/null >/dev/null 2>&1; then
    output_copy=busybox
  elif head --version >/dev/null 2>&1 &&
    stdbuf -o0 head -c 0 </dev/null >/dev/null 2>&1; then
    output_copy=gnu
  else
    # No buffered or per-byte fallback on unsupported systems.
    exit 125
  fi
  rm -f "$output_truncation_temporary" 2>/dev/null || exit 125
  if ! mkfifo -m 600 "$output_quota_fifo" 2>/dev/null; then
    exit 125
  fi

  publish_output_truncation() {
    quota_reached=$1
    truncation_observed_at_ms=$(( $(date +%s) * 1000 ))
    truncation_payload="{\"schemaVersion\":1,\"runId\":\"$run_id\",\"attemptId\":\"$attempt_id\",\"logArtifactId\":\"$output_artifact_id\",\"maximumBytes\":$output_maximum_bytes,\"quotaReached\":$quota_reached,\"observedAtMs\":$truncation_observed_at_ms}"
    if (set -C; printf '%s' "$truncation_payload" > "$output_truncation_temporary") 2>/dev/null; then
      sync -f "$output_truncation_temporary" 2>/dev/null || :
      if ln "$output_truncation_temporary" "$output_truncation_target" 2>/dev/null; then
        sync -f "$output_truncation_target" 2>/dev/null || :
      fi
      rm -f "$output_truncation_temporary" 2>/dev/null || :
      sync -f "${output_truncation_target%/*}" 2>/dev/null || :
    fi
  }

  (
    capture_succeeded=true
    if [ "$output_quota_remaining_bytes" -gt 0 ]; then
      # Diagnostics must not bypass that quota through inherited stderr.
      if [ "$output_copy" = busybox ]; then
        busybox dd bs=16384 count="$output_quota_remaining_bytes" iflag=count_bytes status=none 2>/dev/null || capture_succeeded=false
      else
        stdbuf -o0 head -c "$output_quota_remaining_bytes" 2>/dev/null || capture_succeeded=false
      fi
    fi
    overflow_bytes=$(wc -c | tr -d '[:space:]') || overflow_bytes=
    # A failed copy cannot attest complete capture. Still drain the producer;
    # leave truncation unknown and retain its own exit/receipt semantics.
    if [ "$capture_succeeded" = true ]; then
      case "$overflow_bytes" in
        ''|*[!0-9]*) ;;
        0) publish_output_truncation false ;;
        *) publish_output_truncation true ;;
      esac
    fi
  ) < "$output_quota_fifo" &
  drain_pid=$!
fi

if [ "$launch_mode" = "argv" ]; then
  if [ -n "$output_quota_fifo" ]; then
    "$@" > "$output_quota_fifo" 2>&1 &
  else
    "$@" &
  fi
else
  if [ -n "$output_quota_fifo" ]; then
    "$launch_shell" -c "$launch_shell_command" > "$output_quota_fifo" 2>&1 &
  else
    "$launch_shell" -c "$launch_shell_command" &
  fi
fi
child_pid=$!

forward_term() { kill -TERM "$child_pid" 2>/dev/null || :; }
forward_int() { kill -INT "$child_pid" 2>/dev/null || :; }
forward_hup() { kill -HUP "$child_pid" 2>/dev/null || :; }
trap forward_term TERM
trap forward_int INT
trap forward_hup HUP

# A trapped signal can interrupt wait. Stay alive as process-group leader until
# the exact child exits so recovery never observes a half-alive group as done.
while :; do
  wait "$child_pid"
  exit_code=$?
  if ! kill -0 "$child_pid" 2>/dev/null; then
    break
  fi
done

if [ -n "$drain_pid" ]; then
  wait "$drain_pid" 2>/dev/null || :
  rm -f "$output_quota_fifo" 2>/dev/null || :
fi

finished_at_ms=$(( $(date +%s) * 1000 ))
if [ "$finished_at_ms" -lt "$started_at_ms" ]; then
  finished_at_ms=$started_at_ms
fi
receipt_payload="{\"schemaVersion\":1,\"runId\":\"$run_id\",\"attemptId\":\"$attempt_id\",\"callbackSequence\":$callback_sequence,\"token\":\"$callback_token\",\"startedAtMs\":$started_at_ms,\"finishedAtMs\":$finished_at_ms,\"exitCode\":$exit_code}"

# noclobber protects the temporary name; hard-link publication never replaces
# an existing final fact. Receipt failure must not change the user exit code.
if (set -C; printf '%s' "$receipt_payload" > "$receipt_temporary") 2>/dev/null; then
  sync -f "$receipt_temporary" 2>/dev/null || :
  if ln "$receipt_temporary" "$receipt_target" 2>/dev/null; then
    sync -f "$receipt_target" 2>/dev/null || :
  fi
  rm -f "$receipt_temporary" 2>/dev/null || :
  sync -f "${receipt_target%/*}" 2>/dev/null || :
fi

exit "$exit_code"
