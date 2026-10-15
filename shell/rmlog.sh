#!/usr/bin/env bash

days=$1

remove_js_log() {
  local log log_date log_timestamp diff_time log_path encoded_path result
  local now
  now=$(date +%s) || return $?
  while IFS= read -r -d '' log; do
    log_date=${log##*/}
    log_date=${log_date:0:10}
    if ! [[ $log_date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      if [[ $is_macos -eq 1 ]]; then
        log_date=$(stat -f %Sm -t "%Y-%m-%d" "$log") || continue
      else
        log_date=$(stat -c %y "$log" | cut -d ' ' -f 1)
      fi
    fi
    if [[ $is_macos -eq 1 ]]; then
      # BSD date otherwise fills the omitted time from the current clock.
      log_timestamp=$(date -j -f "%Y-%m-%d %H:%M:%S" "$log_date 00:00:00" +%s) || continue
    else
      log_timestamp=$(date +%s -d "$log_date") || continue
    fi
    diff_time=$((now - log_timestamp))
    if [[ $diff_time -gt $((${days} * 86400)) ]]; then
      log_path=${log#"$dir_log"/}
      encoded_path=$(printf '%s' "$log_path" | jq -sRr @uri) || continue
      result=$(find_cron_api "log_path=$encoded_path")
      t '查询文件 %s' "$log_path"
      if [[ -z $result ]]; then
        t '删除中~'
        rm -vf -- "$log"
      else
        t '正在被 %s 使用，跳过~' "$result"
      fi
    fi
  done < <(find "$dir_log" -type f -name "*.log" -print0)
}

remove_empty_dir() {
  local dir
  for dir in "$dir_log"/*/ "$dir_log"/.[!.]*/ "$dir_log"/..?*/; do
    [[ -d "$dir" ]] || continue
    # rmdir also protects a directory populated between discovery and removal.
    rmdir -- "$dir" 2>/dev/null || true
  done
}

if [[ ${days} ]]; then
  t '查找旧日志文件中...\n'
  remove_js_log
  remove_empty_dir
  t '删除旧日志执行完毕\n'
fi
