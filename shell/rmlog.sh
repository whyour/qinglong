#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=$QL_DIR/shell
. $dir_shell/share.sh

days=$1

## 删除运行js脚本的旧日志
remove_js_log() {
  local log_full_path_list=$(find $dir_log/ -name "*.log")
  local diff_time
  for log in $log_full_path_list; do
    local log_date=$(echo $log | awk -F "/" '{print $NF}' | cut -c1-10) #文件名比文件属性获得的日期要可靠
    if [[ $(date +%s -d $log_date 2>/dev/null) ]]; then
      if [[ $is_macos -eq 1 ]]; then
        diff_time=$(($(date +%s) - $(date -j -f "%Y-%m-%d" "$log_date" +%s)))
      else
        diff_time=$(($(date +%s) - $(date +%s -d "$log_date")))
      fi
      [[ $diff_time -gt $((${days} * 86400)) ]] && rm -vf $log
    fi
  done
}

## 删除空文件夹
remove_empty_dir() {
  cd $dir_log
  for dir in $(ls); do
    if [[ -d $dir ]] && [[ -z $(ls $dir) ]]; then
      rm -rf $dir
    fi
  done
}

## 运行
if [[ ${days} ]]; then
  echo -e "查找旧日志文件中...\n"
  remove_js_log
  remove_empty_dir
  echo -e "删除旧日志执行完毕\n"
fi
