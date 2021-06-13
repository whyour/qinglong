#!/usr/bin/env bash

get_token() {
    token=$(cat $file_auth_user | jq -r .token)
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

    local api=$(
        curl -s "http://localhost:5600/api/crons?t=$currentTimeStamp" \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://localhost:5700" \
            -H "Referer: http://localhost:5700/crontab" \
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
    if [ $# -eq 1 ]; then
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
        curl -s "http://localhost:5600/api/crons?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://localhost:5700" \
            -H "Referer: http://localhost:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"name\":\"$name\",\"command\":\"$command\",\"schedule\":\"$schedule\",\"_id\":\"$id\"}" \
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
    if [ $# -eq 1 ]; then
        local command=$(echo "$1" | awk -F ":" '{print $1}')
        local id=$(echo "$1" | awk -F ":" '{print $2}')
    else
        local command=$1
        local id=$2
    fi

    local api=$(
        curl -s "http://localhost:5600/api/crons?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://localhost:5700" \
            -H "Referer: http://localhost:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"command\":\"$command\",\"_id\":\"$id\"}" \
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
        curl -s "http://localhost:5600/api/crons?t=$currentTimeStamp" \
            -X 'DELETE' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://localhost:5700" \
            -H "Referer: http://localhost:5700/crontab" \
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

get_user_info() {
    local currentTimeStamp=$(date +%s)
    local api=$(
        curl -s "http://localhost:5600/api/user?t=$currentTimeStamp" \
            -H 'Accept: */*' \
            -H "Authorization: Bearer $token" \
            -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36' \
            -H 'Referer: http://localhost:5700/crontab' \
            -H 'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7' \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    if [[ $code != 200 ]]; then
        echo -e "请先登录！"
        exit 0
    fi
}

update_cron_status() {
    local ids=$1
    local status=$2
    local currentTimeStamp=$(date +%s)
    local api=$(
        curl -s "http://localhost:5600/api/crons/status?t=$currentTimeStamp" \
            -X 'PUT' \
            -H "Accept: application/json" \
            -H "Authorization: Bearer $token" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36" \
            -H "Content-Type: application/json;charset=UTF-8" \
            -H "Origin: http://localhost:5700" \
            -H "Referer: http://localhost:5700/crontab" \
            -H "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7" \
            --data-raw "{\"ids\":[$ids],\"status\":\"$status\"}" \
            --compressed
    )
    code=$(echo $api | jq -r .code)
    message=$(echo $api | jq -r .message)
    if [[ $code == 200 ]]; then
        echo -e "更新任务状态成功"
    else
        echo -e "更新任务状态失败(${message})"
    fi
}

get_token