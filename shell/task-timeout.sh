#!/usr/bin/env bash

# Fork from the current Bash state: an external `bash -c` would lose private
# before-hook variables, arrays and functions used by sourced Shell scripts.
run_task_command() {
  local timeout_seconds
  if [[ -z ${command_timeout_time:-} ]]; then
    "$@"
    return $?
  fi
  timeout_seconds=$(awk -v value="$command_timeout_time" 'BEGIN {
    if (value !~ /^([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?[smhd]?$/) exit 1
    unit = substr(value, length(value), 1)
    factor = unit == "d" ? 86400 : unit == "h" ? 3600 : unit == "m" ? 60 : 1
    printf "%.9f", (value + 0) * factor
  }') || { printf 'Invalid task timeout: %s\n' "$command_timeout_time" >&2; return 125; }
  if [[ $timeout_seconds == '0.000000000' ]]; then
    "$@"
    return $?
  fi
  (
    timeout_dir=$(mktemp -d "${TMPDIR:-/tmp}/ql-task-timeout.XXXXXXXX") || exit 125
    # Both children get private process groups. The timer and the wrapper must
    # survive terminating the task, and descendants must not outlive a timeout.
    set -m
    ( set +m; "$@" ) <&0 &
    timeout_worker=$!
    (
      set +m
      : > "$timeout_dir/ready"
      sleep "$timeout_seconds" || exit 125
      : > "$timeout_dir/expired"
      kill -TERM -- "-$timeout_worker" 2>/dev/null || :
      sleep 0.5
      kill -KILL -- "-$timeout_worker" 2>/dev/null || :
    ) &
    timeout_watcher=$!
    set +m
    trap 'kill -KILL -- "-$timeout_watcher" 2>/dev/null || :
      if kill -TERM -- "-$timeout_worker" 2>/dev/null; then sleep 0.1; fi
      kill -KILL -- "-$timeout_worker" 2>/dev/null || :
      wait "$timeout_worker" 2>/dev/null || :
      wait "$timeout_watcher" 2>/dev/null || :
      rm -rf -- "$timeout_dir"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    trap 'exit 131' QUIT
    # Do not clean up a timer whose process group has not initialized yet.
    while [[ ! -f "$timeout_dir/ready" ]]; do
      kill -0 "$timeout_watcher" 2>/dev/null || exit 125
      sleep 0.001
    done
    wait "$timeout_worker"
    timeout_code=$?
    if [[ -f "$timeout_dir/expired" ]]; then
      # Let the timer finish escalation even if the task leader exited first.
      wait "$timeout_watcher" 2>/dev/null || :
      exit 124
    fi
    exit "$timeout_code"
  )
}
