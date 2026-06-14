#!/usr/bin/env bash

create_token() {
  local token_command="ts-node-transpile-only ${dir_root}/back/token.ts"
  local token_file="${dir_root}/static/build/token.js"
  if [[ -f $token_file ]]; then
    token_command="node ${token_file}"
  fi
  __ql_token__=$(eval "$token_command")
}

get_token() {
  if [[ -f $file_auth_token ]]; then
    __ql_token__=$(cat $file_auth_token | jq -r .value)
    local expiration=$(cat $file_auth_token | jq -r .expiration)
    local currentTimeStamp=$(date +%s)
    if [[ $currentTimeStamp -ge $expiration ]]; then
      create_token
    fi
  else
    create_token
  fi
}

add_cron_api() {
  local currentTimeStamp=$(date +%s)
  if [[ $# -eq 1 ]]; then
    local schedule=$(echo "$1" | awk -F ":" '{print $1}')
    local command=$(echo "$1" | awk -F ":" '{print $2}')
    local name=$(echo "$1" | awk -F ":" '{print $3}')
    local sub_id=$(echo "$1" | awk -F ":" '{print $4}')
  else
    local schedule="$1"
    local command="$2"
    local name="$3"
    local sub_id="$4"
  fi

  if [[ ! $sub_id ]]; then
    sub_id="null"
  fi

  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/crons?t=$currentTimeStamp" \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "{\"name\":\"${name//\"/\\\"}\",\"command\":\"${command//\"/\\\"}\",\"schedule\":\"$schedule\",\"sub_id\":$sub_id}" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code == 200 ]]; then
    t '%s -> 添加成功' "$name"
  else
    t '%s -> 添加失败(%s)' "$name" "$message"
  fi
}

update_cron_api() {
  local currentTimeStamp=$(date +%s)
  if [[ $# -eq 1 ]]; then
    local schedule=$(echo "$1" | awk -F ":" '{print $1}')
    local command=$(echo "$1" | awk -F ":" '{print $2}')
    local name=$(echo "$1" | awk -F ":" '{print $3}')
    local id=$(echo "$1" | awk -F ":" '{print $4}')
  else
    local schedule="$1"
    local command="$2"
    local name="$3"
    local id="$4"
  fi

  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/crons?t=$currentTimeStamp" \
      -X 'PUT' \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "{\"name\":\"${name//\"/\\\"}\",\"command\":\"${command//\"/\\\"}\",\"schedule\":\"$schedule\",\"id\":\"$id\"}" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code == 200 ]]; then
    t '%s -> 更新成功' "$name"
  else
    t '%s -> 更新失败(%s)' "$name" "$message"
  fi
}

update_cron_command_api() {
  local currentTimeStamp=$(date +%s)
  if [[ $# -eq 1 ]]; then
    local command=$(echo "$1" | awk -F ":" '{print $1}')
    local id=$(echo "$1" | awk -F ":" '{print $2}')
  else
    local command="$1"
    local id="$2"
  fi

  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/crons?t=$currentTimeStamp" \
      -X 'PUT' \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "{\"command\":\"${command//\"/\\\"}\",\"id\":\"$id\"}" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code == 200 ]]; then
    t '%s -> 更新成功' "$command"
  else
    t '%s -> 更新失败(%s)' "$command" "$message"
  fi
}

del_cron_api() {
  local ids="$1"
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/crons?t=$currentTimeStamp" \
      -X 'DELETE' \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "[$ids]" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code == 200 ]]; then
    t '成功'
  else
    t '失败(%s)' "$message"
  fi
}

update_cron() {
  local ids="$1"
  local status="$2"
  local pid="${3:-''}"
  local logPath="$4"
  local lastExecutingTime="${5:-0}"
  local runningTime="${6:-0}"
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/crons/status?t=$currentTimeStamp" \
      -X 'PUT' \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "{\"ids\":[$ids],\"status\":\"$status\",\"pid\":\"$pid\",\"log_path\":\"$logPath\",\"last_execution_time\":$lastExecutingTime,\"last_running_time\":$runningTime}" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code != 200 ]]; then
    if [[ ! $message ]]; then
      message="$api"
    fi
    echo -e "${message}"
  fi
}

notify_api() {
  local title="$1"
  local content="$2"
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/system/notify?t=$currentTimeStamp" \
      -X 'PUT' \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "{\"title\":\"${title//\"/\\\"}\",\"content\":\"${content//\"/\\\"}\"}" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code == 200 ]]; then
    t '通知发送成功🎉'
  else
    t '通知失败(%s)' "$message"
  fi
}

find_cron_api() {
  local params="$1"
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/crons/detail?$params&t=$currentTimeStamp" \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --compressed
  )
  data=$(echo "$api" | jq -r .data)
  if [[ $data == 'null' ]]; then
    echo -e ""
  else
    name=$(echo "$api" | jq -r .data.name)
    echo -e "$name"
  fi
}

update_auth_config() {
  local body="$1"
  local tip="$2"
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/open/system/auth/reset?t=$currentTimeStamp" \
      -X 'PUT' \
      -H "Authorization: Bearer ${__ql_token__}" \
      -H "Content-Type: application/json;charset=UTF-8" \
      --data-raw "{$body}" \
      --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code == 200 ]]; then
    t '%s成功🎉' "$tip"
  else
    t '%s失败(%s)' "$tip" "$message"
  fi
}

record_cron_stat() {
  local ref_id="$1"
  local exit_code="${2:-0}"
  local elapsed="${3:-0}"
  [[ $ref_id ]] && [[ $ref_id -gt 0 ]] 2>/dev/null || return

  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port:-5700}/open/dashboard/record" \
    -X POST \
    -H "Authorization: Bearer ${__ql_token__}" \
    -H "Content-Type: application/json;charset=UTF-8" \
    --data-raw "{\"ref_id\":$ref_id,\"code\":$exit_code,\"elapsed\":$elapsed}" \
    --compressed
  )
  code=$(echo "$api" | jq -r .code)
  message=$(echo "$api" | jq -r .message)
  if [[ $code != 200 ]]; then
    if [[ ! $message ]]; then
      message="$api"
    fi
    echo -e "${message}"
  fi
}

get_token
