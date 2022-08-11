#!/usr/bin/env bash

get_token() {
    token=$(cat $file_auth_token | jq -r .value)
}

add_cron_api() {
    local currentTimeStamp=$(date +%s)
    if [[ $# -eq 1 ]]; then
        local schedule=$(echo "$1" | awk -F ":" '{print $1}')
        local command=$(echo "$1" | awk -F ":" '{print $2}')
        local name=$(echo "$1" | awk -F ":" '{print $3}')
    else
        local schedule=$1
        local command=$2
        local name=$3
    fi

    local api=$(
        curl -s --noproxy "*" "http://0.0.0.0:5600/open/crons?t=$currentTimeStamp" \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://0.0.0.0:5700" \
            -H "Referer: http://0.0.0.0:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"name\":\"$name\",\"command\":\"$command\",\"schedule\":\"$schedule\"}" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code == 200 ]]; then
        echo -e "$name -> 添加成功"
    else
        echo -e "$name -> 添加失败(${message})"
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
        local schedule=$1
        local command=$2
        local name=$3
        local id=$4
    fi

    local api=$(
        curl -s --noproxy "*" "http://0.0.0.0:5600/open/crons?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://0.0.0.0:5700" \
            -H "Referer: http://0.0.0.0:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"name\":\"$name\",\"command\":\"$command\",\"schedule\":\"$schedule\",\"id\":\"$id\"}" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code == 200 ]]; then
        echo -e "$name -> 更新成功"
    else
        echo -e "$name -> 更新失败(${message})"
    fi
}

update_cron_command_api() {
    local currentTimeStamp=$(date +%s)
    if [[ $# -eq 1 ]]; then
        local command=$(echo "$1" | awk -F ":" '{print $1}')
        local id=$(echo "$1" | awk -F ":" '{print $2}')
    else
        local command=$1
        local id=$2
    fi

    local api=$(
        curl -s --noproxy "*" "http://0.0.0.0:5600/open/crons?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://0.0.0.0:5700" \
            -H "Referer: http://0.0.0.0:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"command\":\"$command\",\"id\":\"$id\"}" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code == 200 ]]; then
        echo -e "$command -> 更新成功"
    else
        echo -e "$command -> 更新失败(${message})"
    fi
}

del_cron_api() {
    local ids=$1
    local currentTimeStamp=$(date +%s)
    local api=$(
        curl -s --noproxy "*" "http://0.0.0.0:5600/open/crons?t=$currentTimeStamp" \
            -X 'DELETE' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://0.0.0.0:5700" \
            -H "Referer: http://0.0.0.0:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "[$ids]" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code == 200 ]]; then
        echo -e "成功"
    else
        echo -e "失败(${message})"
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
        curl -s --noproxy "*" "http://0.0.0.0:5600/open/crons/status?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://0.0.0.0:5700" \
            -H "Referer: http://0.0.0.0:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"ids\":[$ids],\"status\":\"$status\",\"pid\":\"$pid\",\"log_path\":\"$logPath\",\"last_execution_time\":$lastExecutingTime,\"last_running_time\":$runningTime}" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code != 200 ]]; then
        echo -e "\n## 更新任务状态失败(${message})\n" >> $dir_log/$log_path
    fi
}

notify_api() {
    local title=$1
    local content=$2
    local currentTimeStamp=$(date +%s)
    local api=$(
        curl -s --noproxy "*" "http://0.0.0.0:5600/open/system/notify?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://0.0.0.0:5700" \
            -H "Referer: http://0.0.0.0:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"title\":\"$title\",\"content\":\"$content\"}" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code == 200 ]]; then
        echo -e "通知发送成功"
    else
        echo -e "通知失败(${message})"
    fi
}

get_token
