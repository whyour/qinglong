#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=$QL_DIR/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

trap "single_hanle" 2 3 20 15 14 19 1
single_hanle() {
  eval handle_task_end "$@" "$cmd"
  exit 1
}

## 选择python3还是node
define_program() {
  local file_param=$1
  if [[ $file_param == *.js ]] || [[ $file_param == *.mjs ]]; then
    which_program="node"
  elif [[ $file_param == *.py ]] || [[ $file_param == *.pyc ]]; then
    which_program="python3"
  elif [[ $file_param == *.sh ]]; then
    which_program="."
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

  if [[ -z $ID ]]; then
    ID=$(cat $list_crontab_user | grep -E "$cmd_task.* $file_param" | perl -pe "s|.*ID=(.*) $cmd_task.* $file_param\.*|\1|" | head -1 | awk -F " " '{print $1}')
  fi
  local suffix=""
  if [[ ! -z $ID ]]; then
    if [[ "$ID" -gt 0 ]] 2>/dev/null; then
      suffix="_${ID}"
    else
      ID=""
    fi
  fi

  time=$(date "+$mtime_format")
  log_time=$(format_log_time "$mtime_format" "$time")
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
  log_path="$log_dir/$log_time.log"

  if [[ $real_log_path ]]; then
    log_path="$real_log_path"
  fi

  cmd="2>&1 | tee -a $dir_log/$log_path"
  make_dir "$dir_log/$log_dir"
  if [[ "$no_tee" == "true" ]]; then
    cmd=">> $dir_log/$log_path 2>&1"
  fi

  if [[ "$real_time" == "true" ]]; then
    cmd=""
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
  if [[ $command_timeout_time ]]; then
    if type timeout &>/dev/null; then
      timeoutCmd="timeout --foreground -s 2 -k 10s $command_timeout_time "
    fi
  fi
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
  begin_time=$(format_time "$time_format" "$time")
  begin_timestamp=$(format_timestamp "$time_format" "$time")
}

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
[[ $show_log ]] && shift $(($OPTIND - 1))
if [[ $max_time ]]; then
  shift $(($OPTIND - 1))
  command_timeout_time="$max_time"
fi

format_params "$@"
define_program "${task_shell_params[@]}"
handle_log_path "${task_shell_params[@]}"
init_begin_time

eval . $dir_shell/otask.sh "$cmd"
exit 0
