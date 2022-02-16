#!/usr/bin/env bash

dir_shell=/ql/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

send_mark=$dir_shell/send_mark

## 检测cron的差异，$1：脚本清单文件路径，$2：cron任务清单文件路径，$3：增加任务清单文件路径，$4：删除任务清单文件路径
diff_cron() {
    local list_scripts="$1"
    local list_task="$2"
    local list_add="$3"
    local list_drop="$4"
    if [[ -s $list_task ]]; then
        grep -vwf $list_task $list_scripts >$list_add
    elif [[ ! -s $list_task ]] && [[ -s $list_scripts ]]; then
        cp -f $list_scripts $list_add
    fi
    if [[ -s $list_scripts ]]; then
        grep -vwf $list_scripts $list_task >$list_drop
    else
        cp -f $list_task $list_drop
    fi
}

## 检测配置文件版本
detect_config_version() {
    ## 识别出两个文件的版本号
    ver_config_sample=$(grep " Version: " $file_config_sample | perl -pe "s|.+v((\d+\.?){3})|\1|")
    [[ -f $file_config_user ]] && ver_config_user=$(grep " Version: " $file_config_user | perl -pe "s|.+v((\d+\.?){3})|\1|")

    ## 删除旧的发送记录文件
    [[ -f $send_mark ]] && [[ $(cat $send_mark) != $ver_config_sample ]] && rm -f $send_mark

    ## 识别出更新日期和更新内容
    update_date=$(grep " Date: " $file_config_sample | awk -F ": " '{print $2}')
    update_content=$(grep " Update Content: " $file_config_sample | awk -F ": " '{print $2}')

    ## 如果是今天，并且版本号不一致，则发送通知
    if [[ -f $file_config_user ]] && [[ $ver_config_user != $ver_config_sample ]] && [[ $update_date == $(date "+%Y-%m-%d") ]]; then
        if [[ ! -f $send_mark ]]; then
            local notify_title="配置文件更新通知"
            local notify_content="更新日期: $update_date\n用户版本: $ver_config_user\n新的版本: $ver_config_sample\n更新内容: $update_content\n更新说明: 如需使用新功能请对照config.sample.sh，将相关新参数手动增加到你自己的config.sh中，否则请无视本消息。本消息只在该新版本配置文件更新当天发送一次。\n"
            echo -e $notify_content
            notify "$notify_title" "$notify_content"
            [[ $? -eq 0 ]] && echo $ver_config_sample >$send_mark
        fi
    else
        [[ -f $send_mark ]] && rm -f $send_mark
    fi
}

## 输出是否有新的或失效的定时任务，$1：新的或失效的任务清单文件路径，$2：新/失效
output_list_add_drop() {
    local list=$1
    local type=$2
    if [[ -s $list ]]; then
        echo -e "检测到有$type的定时任务：\n"
        cat $list
        echo
    fi
}

## 自动删除失效的脚本与定时任务，需要：1.AutoDelCron 设置为 true；2.正常更新js脚本，没有报错；3.存在失效任务
## $1：失效任务清单文件路径
del_cron() {
    local list_drop=$1
    local path=$2
    local detail=""
    local ids=""
    echo -e "开始尝试自动删除失效的定时任务...\n"
    for cron in $(cat $list_drop); do
        local id=$(cat $list_crontab_user | grep -E "$cmd_task $cron" | perl -pe "s|.*ID=(.*) $cmd_task $cron\.*|\1|" | head -1 | head -1 | awk -F " " '{print $1}')
        if [[ $ids ]]; then
            ids="$ids,\"$id\""
        else
            ids="\"$id\""
        fi
        cron_file="$dir_scripts/${cron}"
        if [[ -f $cron_file ]]; then
            cron_name=$(grep "new Env" $cron_file | awk -F "\(" '{print $2}' | awk -F "\)" '{print $1}' | sed 's:^.\(.*\).$:\1:' | head -1)
            rm -f $cron_file
        fi
        [[ -z $cron_name ]] && cron_name="$cron"
        if [[ $detail ]]; then
            detail="${detail}\n${cron_name}"
        else
            detail="${cron_name}"
        fi
    done
    if [[ $ids ]]; then
        result=$(del_cron_api "$ids")
        notify "$path 删除任务${result}" "$detail"
    fi
}

## 自动增加定时任务，需要：1.AutoAddCron 设置为 true；2.正常更新js脚本，没有报错；3.存在新任务；4.crontab.list存在并且不为空
## $1：新任务清单文件路径
add_cron() {
    local list_add=$1
    local path=$2
    echo -e "开始尝试自动添加定时任务...\n"
    local detail=""
    cd $dir_scripts
    for file in $(cat $list_add); do
        local file_name=${file/${path}\//}
        file_name=${file_name/${path}\_/}
        if [[ -f $file ]]; then
            cron_line=$(
                perl -ne "{
                        print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*$file_name/
                    }" $file |
                    perl -pe "{
                        s|[^\d\*]*(([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$file_name.*|\1|g;
                        s|\*([\d\*])(.*)|\1\2|g;
                        s|  | |g;
                    }" | sort -u | head -1
            )
            cron_name=$(grep "new Env" $file | awk -F "\(" '{print $2}' | awk -F "\)" '{print $1}' | sed 's:^.\(.*\).$:\1:' | head -1)
            [[ -z $cron_name ]] && cron_name="$file_name"
            [[ -z $cron_line ]] && cron_line=$(grep "cron:" $file | awk -F ":" '{print $2}' | head -1 | xargs)
            [[ -z $cron_line ]] && cron_line=$(grep "cron " $file | awk -F "cron \"" '{print $2}' | awk -F "\" " '{print $1}' | head -1 | xargs)
            [[ -z $cron_line ]] && cron_line="$default_cron"
            result=$(add_cron_api "$cron_line:$cmd_task $file:$cron_name")
            echo -e "$result"
            if [[ $detail ]]; then
                detail="${detail}${result}\n"
            else
                detail="${result}\n"
            fi
        fi
    done
    notify "$path 新增任务" "$detail"
}

## 更新仓库
update_repo() {
    local url="$1"
    local path="$2"
    local blackword="$3"
    local dependence="$4"
    local branch="$5"
    local tmp="${url%/*}"
    local authorTmp1="${tmp##*/}"
    local authorTmp2="${authorTmp1##*:}"
    local author="${authorTmp2##*.}"

    local repo_path="${dir_repo}/${uniq_path}"

    make_dir "${dir_scripts}/${uniq_path}"

    local formatUrl="$url"
    if [[ -d ${repo_path}/.git ]]; then
        reset_romote_url ${repo_path} "${formatUrl}" "${branch}"
        git_pull_scripts ${repo_path} "${branch}"
    else
        git_clone_scripts "${formatUrl}" ${repo_path} "${branch}"
    fi
    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新${repo_path}成功...\n"
        diff_scripts "$repo_path" "$author" "$path" "$blackword" "$dependence"
    else
        echo -e "\n更新${repo_path}失败，请检查网络...\n"
    fi
}

## 更新所有 raw 文件
update_raw() {
    echo -e "--------------------------------------------------------------\n"
    local url="$1"
    local raw_url="$url"
    local suffix="${raw_url##*.}"
    local raw_file_name="${uniq_path}.${suffix}"
    echo -e "开始下载：${raw_url} \n\n保存路径：$dir_raw/${raw_file_name}\n"

    set_proxy
    wget -q --no-check-certificate -O "$dir_raw/${raw_file_name}.new" ${raw_url}
    unset_proxy

    if [[ $? -eq 0 ]]; then
        mv "$dir_raw/${raw_file_name}.new" "$dir_raw/${raw_file_name}"
        echo -e "下载 ${raw_file_name} 成功...\n"
        cd $dir_raw
        local filename="raw_${raw_file_name}"
        local cron_id=$(cat $list_crontab_user | grep -E "$cmd_task $filename" | perl -pe "s|.*ID=(.*) $cmd_task $filename\.*|\1|" | head -1 | head -1 | awk -F " " '{print $1}')
        cp -f $raw_file_name $dir_scripts/${filename}
        cron_line=$(
            perl -ne "{
                    print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*$raw_file_name/
                }" $raw_file_name |
                perl -pe "{
                    s|[^\d\*]*(([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$raw_file_name.*|\1|g;
                    s|\*([\d\*])(.*)|\1\2|g;
                    s|  | |g;
                }" | sort -u | head -1
        )
        cron_name=$(grep "new Env" $raw_file_name | awk -F "\(" '{print $2}' | awk -F "\)" '{print $1}' | sed 's:^.\(.*\).$:\1:' | head -1)
        [[ -z $cron_name ]] && cron_name="$raw_file_name"
        [[ -z $cron_line ]] && cron_line=$(grep "cron:" $raw_file_name | awk -F ":" '{print $2}' | head -1 | xargs)
        [[ -z $cron_line ]] && cron_line=$(grep "cron " $raw_file_name | awk -F "cron \"" '{print $2}' | awk -F "\" " '{print $1}' | head -1 | xargs)
        [[ -z $cron_line ]] && cron_line="$default_cron"
        if [[ -z $cron_id ]]; then
            result=$(add_cron_api "$cron_line:$cmd_task $filename:$cron_name")
            echo -e "$result\n"
            notify "新增任务通知" "\n$result"
            # update_cron_api "$cron_line:$cmd_task $filename:$cron_name:$cron_id"
        fi
    else
        echo -e "下载 ${raw_file_name} 失败，保留之前正常下载的版本...\n"
        [[ -f "$dir_raw/${raw_file_name}.new" ]] && rm -f "$dir_raw/${raw_file_name}.new"
    fi

}

## 调用用户自定义的extra.sh
run_extra_shell() {
    if [[ ${EnableExtraShell} == true ]]; then
        if [[ -f $file_extra_shell ]]; then
            echo -e "--------------------------------------------------------------\n"
            . $file_extra_shell
        else
            echo -e "$file_extra_shell文件不存在，跳过执行...\n"
        fi
    fi
}

## 脚本用法
usage() {
    echo -e "本脚本用法："
    echo -e "1. $cmd_update update                                                    # 更新并重启青龙"
    echo -e "2. $cmd_update extra                                                     # 运行自定义脚本"
    echo -e "3. $cmd_update raw <fileurl>                                             # 更新单个脚本文件"
    echo -e "4. $cmd_update repo <repourl> <path> <blacklist> <dependence> <branch>   # 更新单个仓库的脚本"
    echo -e "5. $cmd_update rmlog <days>                                              # 删除旧日志"
    echo -e "6. $cmd_update bot                                                       # 启动tg-bot"
    echo -e "7. $cmd_update check                                                     # 检测青龙环境并修复"
    echo -e "8. $cmd_update resetlet                                                  # 重置登录错误次数"
    echo -e "9. $cmd_update resettfa                                                  # 禁用两步登录"
}

## 更新qinglong
update_qinglong() {
    patch_version

    local no_restart="$1"
    [[ -f $dir_root/package.json ]] && ql_depend_old=$(cat $dir_root/package.json)
    reset_romote_url ${dir_root} "https://github.com/whyour/qinglong.git" ${current_branch}
    git_pull_scripts $dir_root ${current_branch}

    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新$dir_root成功...\n"
        cp -f $file_config_sample $dir_config/config.sample.sh
        detect_config_version
        update_depend

        [[ -f $dir_root/package.json ]] && ql_depend_new=$(cat $dir_root/package.json)
        [[ "$ql_depend_old" != "$ql_depend_new" ]] && npm_install_2 $dir_root
    else
        echo -e "\n更新$dir_root失败，请检查原因...\n"
    fi

    local url="https://github.com/whyour/qinglong-static.git"
    if [[ -d ${ql_static_repo}/.git ]]; then
        reset_romote_url ${ql_static_repo} ${url} ${current_branch}
        git_pull_scripts ${ql_static_repo} ${current_branch}
    else
        git_clone_scripts ${url} ${ql_static_repo}
    fi
    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新$ql_static_repo成功...\n"
        local static_version=$(cat /ql/src/version.ts | perl -pe "s|.*\'(.*)\';\.*|\1|" | head -1)
        echo -e "\n当前版本 $static_version...\n"
        cd $dir_root
        rm -rf $dir_root/build && rm -rf $dir_root/dist
        cp -rf $ql_static_repo/* $dir_root
        if [[ $no_restart != "no-restart" ]]; then
            nginx -s reload 2>/dev/null || nginx -c /etc/nginx/nginx.conf
            echo -e "重启面板中..."
            sleep 3
            reload_pm2
        fi
    else
        echo -e "\n更新$dir_root失败，请检查原因...\n"
    fi

}

patch_version() {
    if [[ -f "/ql/db/cookie.db" ]]; then
        echo -e "检测到旧的db文件，拷贝为新db...\n"
        mv /ql/db/cookie.db /ql/db/env.db
        rm -rf /ql/db/cookie.db
        echo
    fi

    if ! type ts-node &>/dev/null; then
        pnpm i -g ts-node typescript tslib
    fi

    git config --global pull.rebase false

    cp -f /ql/.env.example /ql/.env
}

reload_pm2() {
    pm2 l &>/dev/null

    pm2 delete panel --source-map-support --time &>/dev/null
    pm2 start $dir_root/build/app.js -n panel --source-map-support --time &>/dev/null

    pm2 delete schedule --source-map-support --time &>/dev/null
    pm2 start $dir_root/build/schedule.js -n schedule --source-map-support --time &>/dev/null
}

## 对比脚本
diff_scripts() {
    local dir_current=$(pwd)
    local repo_path="$1"
    local author="$2"
    local path="$3"
    local blackword="$4"
    local dependence="$5"

    gen_list_repo "$repo_path" "$author" "$path" "$blackword" "$dependence"

    local list_add="$dir_list_tmp/${uniq_path}_add.list"
    local list_drop="$dir_list_tmp/${uniq_path}_drop.list"
    diff_cron "$dir_list_tmp/${uniq_path}_scripts.list" "$dir_list_tmp/${uniq_path}_user.list" $list_add $list_drop

    if [[ -s $list_drop ]]; then
        output_list_add_drop $list_drop "失效"
        if [[ ${AutoDelCron} == true ]]; then
            del_cron $list_drop $uniq_path
        fi
    fi
    if [[ -s $list_add ]]; then
        output_list_add_drop $list_add "新"
        if [[ ${AutoAddCron} == true ]]; then
            add_cron $list_add $uniq_path
        fi
    fi
    cd $dir_current
}

## 生成脚本的路径清单文件
gen_list_repo() {
    local dir_current=$(pwd)
    local repo_path="$1"
    local author="$2"
    local path="$3"
    local blackword="$4"
    local dependence="$5"

    rm -f $dir_list_tmp/${uniq_path}*.list &>/dev/null

    cd ${repo_path}

    local cmd="find ."
    local index=0
    for extension in $file_extensions; do
        if [[ $index -eq 0 ]]; then
            cmd="${cmd} -name \"*.${extension}\""
        else
            cmd="${cmd} -o -name \"*.${extension}\""
        fi
        let index+=1
    done
    files=$(eval $cmd | sed 's/^..//')
    if [[ $path ]]; then
        files=$(echo "$files" | egrep $path)
    fi
    if [[ $blackword ]]; then
        files=$(echo "$files" | egrep -v $blackword)
    fi

    cp -f $file_notify_js "${dir_scripts}/${uniq_path}"
    cp -f $file_notify_py "${dir_scripts}/${uniq_path}"

    if [[ $dependence ]]; then
        cd ${repo_path}
        results=$(eval $cmd | sed 's/^..//' | egrep $dependence)
        for _file in ${results}; do
            file_path=$(dirname $_file)
            make_dir "${dir_scripts}/${uniq_path}/${file_path}"
            cp -f $_file "${dir_scripts}/${uniq_path}/${file_path}"
        done
    fi
    
    if [[ -d $dir_dep ]]; then
        cp -rf $dir_dep/* "${dir_scripts}/${uniq_path}" &>/dev/null
    fi

    for file in ${files}; do
        filename=$(basename $file)
        cp -f $file "$dir_scripts/${uniq_path}/${filename}"
        echo "${uniq_path}/${filename}" >>"$dir_list_tmp/${uniq_path}_scripts.list"
        cron_id=$(cat $list_crontab_user | grep -E "$cmd_task ${uniq_path}_${filename}" | perl -pe "s|.*ID=(.*) $cmd_task ${uniq_path}_${filename}\.*|\1|" | head -1 | awk -F " " '{print $1}')
        if [[ $cron_id ]]; then
            result=$(update_cron_command_api "$cmd_task ${uniq_path}/${filename}:$cron_id")
        fi
    done
    grep -E "${cmd_task} ${uniq_path}" ${list_crontab_user} | perl -pe "s|.*ID=(.*) ${cmd_task} (${uniq_path}.*)\.*|\2|" | awk -F " " '{print $1}' | sort -u >"$dir_list_tmp/${uniq_path}_user.list"
    cd $dir_current
}

get_uniq_path() {
    local url="$1"
    local branch="$2"
    local urlTmp="${url%*/}"
    local repoTmp="${urlTmp##*/}"
    local repo="${repoTmp%.*}"
    local tmp="${url%/*}"
    local authorTmp1="${tmp##*/}"
    local authorTmp2="${authorTmp1##*:}"
    local author="${authorTmp2##*.}"

    uniq_path="${author}_${repo}"
    [[ $branch ]] && uniq_path="${uniq_path}_${branch}"
}

main() {
    ## for ql update
    show_log="false"
    while getopts ":l" opt
    do
        case $opt in
            l)
                show_log="true"
                ;;
        esac
    done
    [[ "$show_log" == "true" ]] && shift $(($OPTIND - 1))

    local p1=$1
    local p2=$2
    local p3=$3
    local p4=$4
    local p5=$5
    local p6=$6
    local log_time=$(date "+%Y-%m-%d-%H-%M-%S")
    local log_path="$dir_log/update/${log_time}_$p1.log"
    local begin_time=$(date '+%Y-%m-%d %H:%M:%S')

    case $p1 in
    update)
        cmd=">> $log_path 2>&1"
        [[ "$show_log" == "true" ]] && cmd=""
        eval echo -e "## 开始执行... $begin_time\n" $cmd
        [[ -f $task_error_log_path ]] && eval cat $task_error_log_path $cmd
        eval update_qinglong "$2" $cmd
        ;;
    extra)
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        [[ -f $task_error_log_path ]] && cat $task_error_log_path >>$log_path
        run_extra_shell >>$log_path
        ;;
    repo)
        get_user_info
        get_uniq_path "$p2" "$p6"
        log_path="$dir_log/update/${log_time}_${uniq_path}.log"
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        [[ -f $task_error_log_path ]] && cat $task_error_log_path >>$log_path
        if [[ -n $p2 ]]; then
            update_repo "$p2" "$p3" "$p4" "$p5" "$p6" >>$log_path
        else
            echo -e "命令输入错误...\n"
            usage
        fi
        ;;
    raw)
        get_user_info
        get_uniq_path "$p2"
        log_path="$dir_log/update/${log_time}_${uniq_path}.log"
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        [[ -f $task_error_log_path ]] && cat $task_error_log_path >>$log_path
        if [[ -n $p2 ]]; then
            update_raw "$p2" >>$log_path
        else
            echo -e "命令输入错误...\n"
            usage
        fi
        ;;
    rmlog)
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        [[ -f $task_error_log_path ]] && cat $task_error_log_path >>$log_path
        . $dir_shell/rmlog.sh "$p2" >>$log_path
        ;;
    bot)
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        [[ -f $task_error_log_path ]] && cat $task_error_log_path >>$log_path
        . $dir_shell/bot.sh >>$log_path
        ;;
    check)
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        [[ -f $task_error_log_path ]] && cat $task_error_log_path >>$log_path
        . $dir_shell/check.sh >>$log_path
        ;;
    resetlet)
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        auth_value=$(cat $file_auth_user | jq '.retries =0' -c)
        echo -e "重置登录错误次数成功 \n $auth_value" >>$log_path
        echo "$auth_value" >$file_auth_user
        ;;
    resettfa)
        echo -e "## 开始执行... $begin_time\n" >>$log_path
        auth_value=$(cat $file_auth_user | jq '.twoFactorActivated =false' | jq '.twoFactorActived =false' -c)
        echo -e "禁用两步验证成功 \n $auth_value" >>$log_path
        echo "$auth_value" >$file_auth_user
        ;;
    *)
        echo -e "命令输入错误...\n"
        usage
        ;;
    esac
    local end_time=$(date '+%Y-%m-%d %H:%M:%S')
    local diff_time=$(($(date +%s -d "$end_time") - $(date +%s -d "$begin_time")))
    echo -e "\n## 执行结束... $end_time  耗时 $diff_time 秒" >>$log_path
    cat $log_path
}

main "$@"

exit 0
