#!/usr/bin/env bash

days=$1

## 删除运行脚本的旧日志
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
      if [[ $diff_time -gt $((${days} * 86400)) ]]; then
        local log_path=$(echo "$log" | sed "s,${dir_log}/,,g")
        local result=$(find_cron_api "log_path=$log_path")
        echo -e "查询文件 $log_path"
        if [[ -z $result ]]; then
          echo -e "删除中~"
          rm -vf $log
        else
          echo -e "正在被 $result 使用，跳过~"
        fi
      fi
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
