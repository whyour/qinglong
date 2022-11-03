#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=$QL_DIR/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

random_delay() {
  local random_delay_max=$RandomDelay
  if [[ $random_delay_max ]] && [[ $random_delay_max -gt 0 ]]; then
    local file_param=$1
    local file_extensions=${RandomDelayFileExtensions-"js"}
    local ignored_minutes=${RandomDelayIgnoredMinutes-"0 30"}

    if [[ -n $file_extensions ]]; then
      if ! echo "$file_param" | grep -qE "\.${file_extensions// /$|\\.}$"; then
        # echo -e "\n当前文件需要准点运行, 放弃随机延迟\n"
        return
      fi
    fi

    local current_min
    current_min=$(date "+%-M")
    for minute in $ignored_minutes; do
      if [[ $current_min -eq $minute ]]; then
        # echo -e "\n当前时间需要准点运行, 放弃随机延迟\n"
        return
      fi
    done

    local delay_second=$(($(gen_random_num "$random_delay_max") + 1))
    echo -e "\n命令未添加 \"now\"，随机延迟 $delay_second 秒后再执行任务，如需立即终止，请按 CTRL+C...\n"
    sleep $delay_second
  fi
}

## scripts目录下所有可运行脚本数组
gen_array_scripts() {
  local dir_current=$(pwd)
  local i="-1"
  cd $dir_scripts
  for file in $(ls); do
    if [[ -f $file ]] && [[ $file == *.js && $file != sendNotify.js ]]; then
      let i++
      array_scripts[i]=$(echo "$file" | perl -pe "s|$dir_scripts/||g")
      array_scripts_name[i]=$(grep "new Env" $file | awk -F "'|\"" '{print $2}' | head -1)
      [[ -z ${array_scripts_name[i]} ]] && array_scripts_name[i]="<未识别出活动名称>"
    fi
  done
  cd $dir_current
}

## 使用说明
usage() {
  gen_array_scripts
  echo -e "task命令运行本程序自动添加进crontab的脚本，需要输入脚本的绝对路径或去掉 “$dir_scripts/” 目录后的相对路径（定时任务中请写作相对路径），用法为："
  echo -e "1.$cmd_task <file_name>                                             # 依次执行，如果设置了随机延迟，将随机延迟一定秒数"
  echo -e "2.$cmd_task <file_name> now                                         # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中"
  echo -e "3.$cmd_task <file_name> conc <环境变量名称> <账号编号，空格分隔>(可选的)  # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中，且可指定账号执行"
  echo -e "4.$cmd_task <file_name> desi <环境变量名称> <账号编号，空格分隔>         # 指定账号执行，无论是否设置了随机延迟，均立即运行"
  if [[ ${#array_scripts[*]} -gt 0 ]]; then
    echo -e "\n当前有以下脚本可以运行:"
    for ((i = 0; i < ${#array_scripts[*]}; i++)); do
      echo -e "$(($i + 1)). ${array_scripts_name[i]}：${array_scripts[i]}"
    done
  else
    echo -e "\n暂无脚本可以执行"
  fi
}

## run nohup，$1：文件名，不含路径，带后缀
run_nohup() {
  local file_name=$1
  nohup node $file_name &>$log_path &
}

check_server() {
  cpu_use=$(top -b -n 1 | grep CPU | grep -v -E 'grep|PID' | awk '{print $2}' | cut -f 1 -d "%" | head -n 1)

  mem_free=$(free -m | grep "Mem" | awk '{print $3}' | head -n 1)
  mem_total=$(free -m | grep "Mem" | awk '{print $2}' | head -n 1)
  mem_use=$(printf "%d%%" $((mem_free * 100 / mem_total)) | cut -f 1 -d "%" | head -n 1)

  disk_use=$(df -P | grep /dev | grep -v -E '(tmp|boot|shm)' | awk '{print $5}' | cut -f 1 -d "%" | head -n 1)

  if [[ $cpu_use -gt $cpu_warn ]] || [[ $mem_free -lt $mem_warn ]] || [[ $disk_use -gt $disk_warn ]]; then
    local resource=$(top -b -n 1 | grep -v -E 'grep|Mem|idle|Load|tr' | awk '{$2="";$3="";$4="";$5="";$7="";print $0}' | head -n 10 | tr '\n' '|' | sed s/\|/\\\\n/g)
    notify_api "服务器资源异常警告" "当前CPU占用 $cpu_use% 内存占用 $mem_use% 磁盘占用 $disk_use% \n资源占用详情 \n\n $resource"
  fi
}

handle_task_before() {
  begin_time=$(format_time "$time_format" "$time")
  begin_timestamp=$(format_timestamp "$time_format" "$time")

  echo -e "## 开始执行... $begin_time\n"

  [[ $is_macos -eq 0 ]] && check_server

  if [[ -s $task_error_log_path ]]; then
    eval cat $task_error_log_path $cmd
    eval echo -e "加载 config.sh 出错，请手动检查" $cmd
    eval echo $cmd
  fi

  [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"
  . $file_task_before "$@"
}

handle_task_after() {
  . $file_task_after "$@"

  local etime=$(date "+$time_format")
  local end_time=$(format_time "$time_format" "$etime")
  local end_timestamp=$(format_timestamp "$time_format" "$etime")
  local diff_time=$(($end_timestamp - $begin_timestamp))
  
  [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
  echo -e "\n\n## 执行结束... $end_time  耗时 $diff_time 秒"
  echo -e "\n　　　　　"
}

## 正常运行单个脚本，$1：传入参数
run_normal() {
  local file_param=$1
  if [[ $# -eq 1 ]]; then
    random_delay "$file_param"
  fi

  cd $dir_scripts
  local relative_path="${file_param%/*}"
  if [[ ${file_param} != /* ]] && [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
    cd ${relative_path}
    file_param=${file_param/$relative_path\//}
  fi

  $timeoutCmd $which_program $file_param
}

## 并发执行时，设定的 RandomDelay 不会生效，即所有任务立即执行
run_concurrent() {
  local file_param="$1"
  local env_param="$2"
  local num_param=$(echo "$3" | perl -pe "s|.*$2(.*)|\1|")
  if [[ ! $env_param ]]; then
    echo -e "\n 缺少并发运行的环境变量参数"
    exit 1
  fi

  local envs=$(eval echo "\$${env_param}")
  local array=($(echo $envs | sed 's/&/ /g'))
  local tempArr=$(echo $num_param | sed  "s/-max/-${#array[@]}/g" | sed  "s/max-/${#array[@]}-/g" | perl -pe "s|(\d+)(-\|~\|_)(\d+)|{\1..\3}|g")
  local runArr=($(eval echo $tempArr))
  runArr=($(awk -v RS=' ' '!a[$1]++' <<<${runArr[@]}))

  local n=0
  for i in ${runArr[@]}; do
    array_run[n]=${array[$i - 1]}
    let n++
  done

  local cookieStr=$(echo ${array_run[*]} | sed 's/\ /\&/g')
  [[ ! -z $cookieStr ]] && export ${env_param}=${cookieStr}

  local envs=$(eval echo "\$${env_param}")
  local array=($(echo $envs | sed 's/&/ /g'))
  single_log_time=$(date "+%Y-%m-%d-%H-%M-%S.%N")

  cd $dir_scripts
  local relative_path="${file_param%/*}"
  if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
    cd ${relative_path}
    file_param=${file_param/$relative_path\//}
  fi
  for i in "${!array[@]}"; do
    export ${env_param}=${array[i]}
    single_log_path="$dir_log/$log_dir/${single_log_time}_$((i + 1)).log"
    eval $timeoutCmd $which_program $file_param &>$single_log_path &
  done

  wait
  for i in "${!array[@]}"; do
    single_log_path="$dir_log/$log_dir/${single_log_time}_$((i + 1)).log"
    cat $single_log_path
    [[ -f $single_log_path ]] && rm -f $single_log_path
  done
}

run_designated() {
  local file_param="$1"
  local env_param="$2"
  local num_param=$(echo "$3" | perl -pe "s|.*$2(.*)|\1|")
  if [[ ! $env_param ]] || [[ ! $num_param ]]; then
    echo -e "\n 缺少单独运行的参数 task xxx.js desi Test 1 3"
    exit 1
  fi

  local envs=$(eval echo "\$${env_param}")
  local array=($(echo $envs | sed 's/&/ /g'))
  local tempArr=$(echo $num_param | sed  "s/-max/-${#array[@]}/g" | sed  "s/max-/${#array[@]}-/g" | perl -pe "s|(\d+)(-\|~\|_)(\d+)|{\1..\3}|g")
  local runArr=($(eval echo $tempArr))
  runArr=($(awk -v RS=' ' '!a[$1]++' <<<${runArr[@]}))

  local n=0
  for i in ${runArr[@]}; do
    array_run[n]=${array[$i - 1]}
    let n++
  done

  local cookieStr=$(echo ${array_run[*]} | sed 's/\ /\&/g')
  [[ ! -z $cookieStr ]] && export ${env_param}=${cookieStr}

  cd $dir_scripts
  local relative_path="${file_param%/*}"
  if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
    cd ${relative_path}
    file_param=${file_param/$relative_path\//}
  fi
  $timeoutCmd $which_program $file_param
}

## 运行其他命令
run_else() {
  local file_param="$1"

  cd $dir_scripts
  local relative_path="${file_param%/*}"
  if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
    cd ${relative_path}
    file_param=${file_param/$relative_path\//}
  fi

  shift

  $timeoutCmd $which_program $file_param "$@"
}

## 命令检测
main() {
  if [[ $1 == *.js ]] || [[ $1 == *.py ]] || [[ $1 == *.pyc ]] || [[ $1 == *.sh ]] || [[ $1 == *.ts ]]; then
    case $# in
    1)
      run_normal "$1"
      ;;
    *)
      case $2 in
      now)
        run_normal "$1" "$2"
        ;;
      conc)
        run_concurrent "$1" "$3" "$*"
        ;;
      desi)
        run_designated "$1" "$3" "$*"
        ;;
      *)
        run_else "$@"
        ;;
      esac
      ;;
    esac
  elif [[ $# -eq 0 ]]; then
    echo
    usage
  else
    run_else "$@"
  fi
}

handle_task_before "$@"
main "$@"
handle_task_after "$@"
