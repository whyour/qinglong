#!/usr/bin/env bash

dir_shell=$QL_DIR/shell
if [[ ${QL_TRIGGER_SOURCE:-} == system && -z ${QL_TRIGGER_ID:-} && ${ID:-} =~ ^[0-9]+$ ]]; then
  . "$dir_shell/system-cron.sh"
fi
. "$dir_shell/share.sh"
. "$dir_shell/api.sh"
. "$dir_shell/task-timeout.sh"

trap 'single_hanle SIGINT'  INT
trap 'single_hanle SIGTERM' TERM
trap 'single_hanle SIGHUP'  HUP
trap 'single_hanle SIGALRM' ALRM
trap 'single_hanle SIGTSTP' TSTP
trap 'single_hanle SIGQUIT' QUIT

single_hanle() {
  _task_exit_code="${_task_exit_code:-$?}"
  [[ "$_task_exit_code" == "0" ]] && _task_exit_code="1"
  eval MANUAL=true handle_task_end "$@"
  exit 1
}

run_shell_script() {
  # Preserve inherited variables/functions, but contain exit, exec and shell
  # options so the task wrapper can run after hooks and report completion.
  (
    if [[ -n ${QL_SCRIPT_START_FILE:-} && -r $1 ]]; then
      local stamp=${EPOCHREALTIME:-}
      if [[ $stamp == *.* ]]; then
        stamp=${stamp/./}; stamp=${stamp:0:13}
      else
        stamp=$(date +%s%3N)
      fi
      if [[ $stamp =~ ^[0-9]{13}$ ]]; then
        ( set -C; printf '%s' "$stamp" > "$QL_SCRIPT_START_FILE" ) 2>/dev/null || :
      fi
    fi
    . "$@"
  )
}

define_program() {
  local file_param=$1
  if [[ $file_param == *.js ]] || [[ $file_param == *.mjs ]]; then
    which_program="node"
  elif [[ $file_param == *.py ]] || [[ $file_param == *.pyc ]]; then
    which_program="python3"
  elif [[ $file_param == *.sh ]]; then
    which_program="run_shell_script"
  elif [[ $file_param == *.ts ]]; then
    which_program="ts-node-transpile-only"
  else
    which_program=""
  fi
}

handle_log_path() {
  local file_param=$1

  if [[ -z $file_param ]]; then
    file_param="task"
  fi

  if [[ -z ${ID:=} ]]; then
    ID=$(cat "$list_crontab_user" | grep -E "$cmd_task.* $file_param" | perl -pe "s|.*ID=(.*) $cmd_task.* $file_param\.*|\1|" | head -1 | awk -F " " '{print $1}')
  fi
  local suffix=""
  if [[ ! -z $ID ]]; then
    if [[ "$ID" -gt 0 ]] 2>/dev/null; then
      suffix="_${ID}"
    else
      ID=""
    fi
  fi

  if [[ $is_macos -ne 1 && $mtime_format == '%Y-%m-%d %H:%M:%S.%3N' ]]; then
    # Render both representations from one clock snapshot, without parsing it
    # again in a second date process.
    IFS='|' read -r time log_time < <(date "+$mtime_format|%Y-%m-%d-%H-%M-%S-%3N")
  else
    time=$(date "+$mtime_format")
    log_time=$(format_log_time "$mtime_format" "$time")
  fi
  if [[ -z $log_name ]]; then
    log_dir_tmp="${file_param##*/}"
    if [[ $file_param =~ "/" ]]; then
      if [[ $file_param == /* ]]; then
        log_dir_tmp_path="${file_param:1}"
      else
        log_dir_tmp_path="${file_param}"
      fi
    fi
    log_dir_tmp_path="${log_dir_tmp_path%/*}"
    log_dir_tmp_path="${log_dir_tmp_path##*/}"
    [[ $log_dir_tmp_path ]] && log_dir_tmp="${log_dir_tmp_path}_${log_dir_tmp}"
    log_dir="${log_dir_tmp%.*}${suffix}"
  else
    log_dir="$log_name"
  fi
  local run_suffix=""
  [[ ${QL_TRIGGER_ID:-} =~ ^[a-z0-9-]{1,120}$ ]] && run_suffix="-$QL_TRIGGER_ID"
  log_path="$log_dir/$log_time$run_suffix.log"

  if [[ ${real_log_path:=} ]]; then
    log_path="$real_log_path"
  fi

  printf -v cmd '2>&1 | tee -a %q' "$dir_log/$log_path"
  make_dir "$dir_log/$log_dir"
  if [[ "${no_tee:=}" == "true" ]]; then
    printf -v cmd '>> %q 2>&1' "$dir_log/$log_path"
  fi

  if [[ "${real_time:=}" == "true" ]]; then
    cmd=""
  fi

  if [[ "${log_dir:=}" == "/dev/null" ]]; then
    cmd=">> /dev/null"
    log_path="/dev/null"
  fi
}

format_params() {
  time_format="%Y-%m-%d %H:%M:%S"
  if [[ $is_macos -eq 1 ]]; then
    mtime_format=$time_format
  else
    mtime_format="%Y-%m-%d %H:%M:%S.%3N"
  fi
  timeoutCmd=""
  # params=$(echo "$@" | sed -E 's/([^ ])&([^ ])/\1\\\&\2/g')

  # 分割 task 内置参数和脚本参数
  task_shell_params=()
  script_params=()
  found_double_dash=false

  for arg in "$@"; do
    if $found_double_dash; then
      script_params+=("$arg")
    elif [ "$arg" == "--" ]; then
      found_double_dash=true
    else
      task_shell_params+=("$arg")
    fi
  done
}

init_begin_time() {
  if [[ $is_macos -ne 1 && $mtime_format == '%Y-%m-%d %H:%M:%S.%3N' && $time_format == '%Y-%m-%d %H:%M:%S' ]]; then
    begin_time=${time%.*}
  else
    begin_time=$(format_time "$time_format" "$time")
  fi
  begin_timestamp=$(format_timestamp "$time_format" "$time")
}

import_config "$@"
while getopts ":lm:" opt; do
  case $opt in
  l)
    show_log="true"
    ;;
  m)
    max_time="$OPTARG"
    ;;
  esac
done
[[ ${show_log:=} ]] && shift $(($OPTIND - 1))
if [[ ${max_time:=} ]]; then
  shift $(($OPTIND - 1))
  command_timeout_time="$max_time"
fi

format_params "$@"
define_program "${task_shell_params[@]}"
handle_log_path "${task_shell_params[@]}"
if [[ -n $ID && -z ${QL_TRIGGER_ID:-} ]]; then init_execution_id || exit 1; fi
init_begin_time

eval '. "$dir_shell/otask.sh"' "$cmd" '; task_status=${PIPESTATUS[0]}'
if [[ -n ${QL_TRIGGER_ID:-} || ${QL_TRIGGER_SOURCE:-} == system ]]; then
  exit "$task_status"
fi
exit 0
