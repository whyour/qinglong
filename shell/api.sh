#!/usr/bin/env bash

get_token() {
  token=$(cat $file_auth_user | jq -r .token)
}

get_json_value() {
    local json=$1
    local key=$2

    if [[ -z "$3" ]]; then
        local num=1
    else
        local num=$3
    fi

    local value=$(echo "${json}" | awk -F"[,:}]" '{for(i=1;i<=NF;i++){if($i~/'${key}'\042/){print $(i+1)}}}' | tr -d '"' | sed -n ${num}p)

    echo ${value}
}

add_cron_api() {
    local currentTimeStamp=$(date +%s)
    if [ $# -eq 1 ]; then
        local schedule=$(echo "$1" | awk -F ":" '{print $1}')
        local command=$(echo "$1" | awk -F ":" '{print $2}')
        local name=$(echo "$1" | awk -F ":" '{print $3}')
    else
        local schedule=$1
        local command=$2
        local name=$3
    fi

  local api=$(curl "http://localhost:5600/api/crons?t=$currentTimeStamp" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer $token" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -H "Origin: http://localhost:5700" \
    -H "Referer: http://localhost:5700/crontab" \
    -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
    --data-raw "{\"name\":\"$name\",\"command\":\"$command\",\"schedule\":\"$schedule\"}" \
    --compressed)
  code=$(echo $api | jq -r .code)
  if [[ $code == 200 ]]; then
    echo -e "$name 添加成功"
  else
    echo -e "$name 添加失败"
  fi
}

del_cron_api() {
  local id=$1
  local currentTimeStamp=$(date +%s)
  local api=$(curl "http://localhost:5600/api/crons/$id?t=$currentTimeStamp" \
    -X 'DELETE' \
    -H "Accept: application/json" \
    -H "Authorization: Bearer $token" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -H "Origin: http://localhost:5700" \
    -H "Referer: http://localhost:5700/crontab" \
    -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7")
  code=$(echo $api | jq -r .code)
  if [[ $code == 200 ]]; then
    echo -e "$name 删除成功"
  else
    echo -e "$name 删除失败"
  fi
}
