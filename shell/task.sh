#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=$QL_DIR/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

## 选择python3还是node
define_program() {
  local file_param=$1
  if [[ $file_param == *.js ]]; then
    which_program="node"
  elif [[ $file_param == *.py ]] || [[ $file_param == *.pyc ]]; then
    which_program="python3"
  elif [[ $file_param == *.sh ]]; then
    which_program="bash"
  elif [[ $file_param == *.ts ]]; then
    which_program="ts-node-transpile-only"
  else
    which_program=""
  fi
}

handle_log_path() {
  local file_param=$1

  if [[ -z $file_param ]];then
    file_param="task"
  fi

  local suffix=""
  if [[ ! -z $ID ]]; then
    suffix="_${ID}"
  fi
  time=$(date "+$time_format")
  log_time=$(format_log_time "$time_format" "$time")
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
  cmd=">> $dir_log/$log_path 2>&1"
  [[ "$show_log" == "true" ]] && cmd=""
  make_dir "$dir_log/$log_dir"
}

format_params() {
  time_format="%Y-%m-%d %H:%M:%S"
  timeoutCmd=""
  if type timeout &>/dev/null; then
    timeoutCmd="timeout -k 10s $command_timeout_time "
  fi
}

show_log="false"
while getopts ":l" opt; do
  case $opt in
  l)
    show_log="true"
    ;;
  esac
done
[[ "$show_log" == "true" ]] && shift $(($OPTIND - 1))

format_params
define_program "$@"
handle_log_path "$@"
eval . $dir_shell/otask.sh "$@" "$cmd"
[[ -f "$dir_log/$log_path" ]] && cat "$dir_log/$log_path"

exit 0
