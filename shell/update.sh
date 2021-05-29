#!/usr/bin/env bash

# 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

send_mark=$dir_shell/send_mark

get_token

## 重置仓库remote url，docker专用，$1：要重置的目录，$2：要重置为的网址
reset_romote_url() {
    local dir_current=$(pwd)
    local dir_work=$1
    local url=$2

    if [ -d "$dir_work/.git" ]; then
        cd $dir_work
        git remote set-url origin $url >/dev/null
        git reset --hard >/dev/null
        cd $dir_current
    fi
}

## 检测cron的差异，$1：脚本清单文件路径，$2：cron任务清单文件路径，$3：增加任务清单文件路径，$4：删除任务清单文件路径
diff_cron() {
    local list_scripts="$1"
    local list_task="$2"
    local list_add="$3"
    local list_drop="$4"
    if [ -s $list_task ]; then
        grep -vwf $list_task $list_scripts >$list_add
    elif [ ! -s $list_task ] && [ -s $list_scripts ]; then
        cp -f $list_scripts $list_add
    fi
    if [ -s $list_scripts ]; then
        grep -vwf $list_scripts $list_task >$list_drop
    else
        cp -f $list_task $list_drop
    fi
}

## 检测配置文件版本
detect_config_version() {
    ## 识别出两个文件的版本号
    ver_config_sample=$(grep " Version: " $file_config_sample | perl -pe "s|.+v((\d+\.?){3})|\1|")
    [ -f $file_config_user ] && ver_config_user=$(grep " Version: " $file_config_user | perl -pe "s|.+v((\d+\.?){3})|\1|")

    ## 删除旧的发送记录文件
    [ -f $send_mark ] && [[ $(cat $send_mark) != $ver_config_sample ]] && rm -f $send_mark

    ## 识别出更新日期和更新内容
    update_date=$(grep " Date: " $file_config_sample | awk -F ": " '{print $2}')
    update_content=$(grep " Update Content: " $file_config_sample | awk -F ": " '{print $2}')

    ## 如果是今天，并且版本号不一致，则发送通知
    if [ -f $file_config_user ] && [[ $ver_config_user != $ver_config_sample ]] && [[ $update_date == $(date "+%Y-%m-%d") ]]; then
        if [ ! -f $send_mark ]; then
            local notify_title="配置文件更新通知"
            local notify_content="更新日期: $update_date\n用户版本: $ver_config_user\n新的版本: $ver_config_sample\n更新内容: $update_content\n更新说明: 如需使用新功能请对照config.sample.sh，将相关新参数手动增加到你自己的config.sh中，否则请无视本消息。本消息只在该新版本配置文件更新当天发送一次。\n"
            echo -e $notify_content
            notify "$notify_title" "$notify_content"
            [[ $? -eq 0 ]] && echo $ver_config_sample >$send_mark
        fi
    else
        [ -f $send_mark ] && rm -f $send_mark
    fi
}

## 输出是否有新的或失效的定时任务，$1：新的或失效的任务清单文件路径，$2：新/失效
output_list_add_drop() {
    local list=$1
    local type=$2
    if [ -s $list ]; then
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
        local id=$(cat $list_crontab_user | grep -E "$cmd_task $cron$" | perl -pe "s|.*ID=(.*) $cmd_task $cron$|\1|" | xargs | sed 's/ /","/g')
        if [[ $ids ]]; then
            ids="$ids,\"$id\""
        else
            ids="\"$id\""
        fi
        cron_file="$dir_scripts/${cron}"
        if [[ -f $cron_file ]]; then
            cron_name=$(grep "new Env" $cron_file | awk -F "'|\"" '{print $2}' | head -1)
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
        local file_name=${file/${path}\_/}
        if [ -f $file ]; then
            cron_line=$(
                perl -ne "{
                        print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*$file_name/
                    }" $file |
                    perl -pe "{
                        s|[^\d\*]*(([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$file_name.*|\1|g;
                        s|  | |g
                    }" | sort -u | head -1
            )
            cron_name=$(grep "new Env" $file | awk -F "'|\"" '{print $2}' | head -1)
            [[ -z $cron_name ]] && cron_name="$file_name"
            [[ -z $cron_line ]] && cron_line="0 6 * * *"
            result=$(add_cron_api "$cron_line:$cmd_task $file:$cron_name")
            echo -e "$result"
            if [[ $detail ]]; then
                detail="${detail}\n${result}"
            else
                detail="${result}"
            fi
        fi
    done
    notify "$path 新增任务" "$detail"
}

## 更新仓库
update_repo() {
    echo -e "--------------------------------------------------------------\n"
    local url="$1"
    local path="$2"
    local blackword="$3"
    local dependence="$4"
    local urlTmp="${url%*/}"
    local repoTmp="${urlTmp##*/}"
    local repo="${repoTmp%.*}"
    local tmp="${url%/*}"
    local authorTmp1="${tmp##*/}"
    local authorTmp2="${authorTmp1##*:}"
    local author="${authorTmp2##*.}"

    local repo_path="${dir_repo}/${author}_${repo}"
    if [ -d ${repo_path}/.git ]; then
        reset_romote_url ${repo_path} ${url}
        git_pull_scripts ${repo_path}
    else
        git_clone_scripts ${url} ${repo_path}
    fi
    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新${repo_path}成功...\n"
        diff_scripts $repo_path $author $path $blackword $dependence
    else
        echo -e "\n更新${repo_path}失败，请检查原因...\n"
    fi
}

## 更新所有 raw 文件
update_raw() {
    echo -e "--------------------------------------------------------------\n"
    local raw_url="$1"
    raw_file_name=$(echo ${raw_url} | awk -F "/" '{print $NF}')
    echo -e "开始下载：${raw_url} \n\n保存路径：$dir_raw/${raw_file_name}\n"
    wget -q --no-check-certificate -O "$dir_raw/${raw_file_name}.new" ${raw_url}
    if [[ $? -eq 0 ]]; then
        mv "$dir_raw/${raw_file_name}.new" "$dir_raw/${raw_file_name}"
        echo -e "下载 ${raw_file_name} 成功...\n"
        cd $dir_raw
        local filename="raw_${raw_file_name}"
        local cron_id=$(cat $list_crontab_user | grep -E "$cmd_task $filename$" | perl -pe "s|.*ID=(.*) $cmd_task $filename$|\1|")
        cp -f $raw_file_name $dir_scripts/${filename}
        cron_line=$(
            perl -ne "{
                    print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*$raw_file_name/
                }" $raw_file_name |
                perl -pe "{
                    s|[^\d\*]*(([\d\*]*[\*-\/,\d]*[\d\*] ){4,5}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$raw_file_name.*|\1|g;
                    s|  | |g
                }" | sort -u | head -1
        )
        cron_name=$(grep "new Env" $raw_file_name | awk -F "'|\"" '{print $2}' | head -1)
        [[ -z $cron_name ]] && cron_name="$raw_file_name"
        [[ -z $cron_line ]] && cron_line="0 6 * * *"
        if [[ -z $cron_id ]]; then
            result=$(add_cron_api "$cron_line:$cmd_task $filename:$cron_name")
            echo -e "$result"
            notify "新增任务通知" "\n$result"
            # update_cron_api "$cron_line:$cmd_task $filename:$cron_name:$cron_id"
        fi
    else
        echo -e "下载 ${raw_file_name} 失败，保留之前正常下载的版本...\n"
        [ -f "$dir_raw/${raw_file_name}.new" ] && rm -f "$dir_raw/${raw_file_name}.new"
    fi

}

## 调用用户自定义的extra.sh
run_extra_shell() {
    if [[ ${EnableExtraShell} == true ]]; then
        if [ -f $file_extra_shell ]; then
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
    echo -e "1. $cmd_update update                                           # 更新并重启青龙"
    echo -e "1. $cmd_update extra                                            # 运行自定义脚本"
    echo -e "3. $cmd_update raw <fileurl>                                    # 更新单个脚本文件"
    echo -e "4. $cmd_update repo <repourl> <path> <blacklist> <dependence>   # 更新单个仓库的脚本"
    echo -e "5. $cmd_update rmlog <days>                                     # 删除旧日志"
    echo -e "6. $cmd_update code                                             # 获取互助码"
    echo -e "6. $cmd_update bot                                              # 启动tg-bot"
}

## 更新qinglong
update_qinglong() {
    echo -e "--------------------------------------------------------------\n"
    [ -f $dir_root/package.json ] && ql_depend_old=$(cat $dir_root/package.json)
    git_pull_scripts $dir_root

    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新$dir_root成功...\n"
        cp -f $file_config_sample $dir_config/config.sample.sh
        detect_config_version
        update_depend

        [ -f $dir_root/package.json ] && ql_depend_new=$(cat $dir_root/package.json)
        [[ "$ql_depend_old" != "$ql_depend_new" ]] && npm_install_2 $dir_root
    else
        echo -e "\n更新$dir_root失败，请检查原因...\n"
    fi

    local url="https://ghproxy.com/https://github.com/whyour/qinglong-static.git"
    if [ -d ${ql_static_repo}/.git ]; then
        reset_romote_url ${ql_static_repo} ${url}
        cd ${ql_static_repo}
        git fetch --all
        exit_status=$?
        git reset --hard origin/master
        cd $dir_root
    else
        git_clone_scripts ${url} ${ql_static_repo}
    fi
    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新$ql_static_repo成功...\n"
        cd $ql_static_repo
        commit_id=$(git rev-parse --short HEAD)
        echo -e "\n当前静态资源版本 $commit_id...\n"
        cd $dir_root
        rm -rf $dir_root/build && rm -rf $dir_root/dist
        cp -rf $ql_static_repo/* $dir_root
        echo -e "重启面板中..."
        nginx -s reload 2>/dev/null || nginx -c /etc/nginx/nginx.conf
        sleep 1
        reload_pm2
    else
        echo -e "\n更新$dir_root失败，请检查原因...\n"
    fi

}

reload_pm2() {
    if [[ $(pm2 info panel 2>/dev/null) ]]; then
        pm2 reload panel >/dev/null 2>&1
    else
        pm2 start $dir_root/build/app.js -n panel >/dev/null 2>&1
    fi

    if [[ $(pm2 info schedule 2>/dev/null) ]]; then
        pm2 reload schedule >/dev/null 2>&1
    else
        pm2 start $dir_root/build/schedule.js -n schedule >/dev/null 2>&1
    fi
}

## 对比脚本
diff_scripts() {
    local dir_current=$(pwd)
    local repo_path="$1"
    local author="$2"
    local path="$3"
    local blackword="$4"
    local dependence="$5"

    gen_list_repo $repo_path $author $path $blackword $dependence

    local repo="${repo_path##*/}"
    local list_add="$dir_list_tmp/${repo}_add.list"
    local list_drop="$dir_list_tmp/${repo}_drop.list"
    diff_cron "$dir_list_tmp/${repo}_scripts.list" "$dir_list_tmp/${repo}_user.list" $list_add $list_drop

    if [ -s $list_drop ]; then
        output_list_add_drop $list_drop "失效"
        if [[ ${AutoDelCron} == true ]]; then
            del_cron $list_drop $repo
        fi
    fi
    if [ -s $list_add ]; then
        output_list_add_drop $list_add "新"
        if [[ ${AutoAddCron} == true ]]; then
            add_cron $list_add $repo
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

    local repo="${repo_path##*/}"
    rm -f $dir_list_tmp/${repo}*.list >/dev/null 2>&1

    cd ${repo_path}
    files=$(find . -name "*.js" | sed 's/^..//')
    if [[ $path ]]; then
        files=$(find . -name "*.js" | sed 's/^..//' | egrep $path)
    fi
    if [[ $blackword ]]; then
        files=$(find . -name "*.js" | sed 's/^..//' | egrep -v $blackword | egrep $path)
    fi
    if [[ $dependence ]]; then
        find . -name "*.js" | sed 's/^..//' | egrep $dependence | xargs -i cp {} $dir_scripts
    fi
    for file in ${files}; do
        filename=$(basename $file)
        cp -f $file $dir_scripts/${repo}_${filename}
        echo ${repo}_${filename} >>"$dir_list_tmp/${repo}_scripts.list"
        cron_id=$(cat $list_crontab_user | grep -E "$cmd_task ${author}_${filename}" | perl -pe "s|.*ID=(.*) $cmd_task ${author}_${filename}\.*|\1|")
        if [[ $cron_id ]]; then
            result=$(update_cron_command_api "$cmd_task ${repo}_${filename}:$cron_id")
        fi
    done
    grep -E "$cmd_task $repo" $list_crontab_user | perl -pe "s|.*ID=(.*) $cmd_task ($repo_.*)\.*|\2|" | awk -F " " '{print $1}' | sort -u >"$dir_list_tmp/${repo}_user.list"
    cd $dir_current
}

main() {
    local p1=$1
    local p2=$2
    local p3=$3
    local p4=$4
    local p5=$5
    log_time=$(date "+%Y-%m-%d-%H-%M-%S")
    log_path="$dir_log/update/${log_time}_$p1.log"
    case $p1 in
    update)
        update_qinglong | tee $log_path
        ;;
    extra)
        run_extra_shell | tee -a $log_path
        ;;
    repo)
        get_user_info
        local name=$(echo "${p2##*/}" | awk -F "." '{print $1}')
        log_path="$dir_log/update/${log_time}_$name.log"
        if [[ -n $p2 ]]; then
            update_repo "$p2" "$p3" "$p4" "$p5" | tee $log_path
        else
            echo -e "命令输入错误...\n"
            usage
        fi
        ;;
    raw)
        get_user_info
        local name=$(echo "${p2##*/}" | awk -F "." '{print $1}')
        log_path="$dir_log/update/${log_time}_$name.log"
        if [[ -n $p2 ]]; then
            update_raw "$p2" | tee $log_path
        else
            echo -e "命令输入错误...\n"
            usage
        fi
        ;;
    rmlog)
        . $dir_shell/rmlog.sh "$p2" | tee $log_path
        ;;
    code)
        . $dir_shell/code.sh
        ;;
    bot)
        . $dir_shell/bot.sh
        ;;
    *)
        echo -e "命令输入错误...\n"
        usage
        ;;
    esac
}

main "$@"

exit 0
