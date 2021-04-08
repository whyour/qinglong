#!/usr/bin/env bash

## 文件路径、脚本网址
dir_shell=$(dirname $(readlink -f "$0"))
dir_root=$(cd $dir_shell; cd ..; pwd)
send_mark=$dir_shell/send_mark

## 导入通用变量与函数
. $dir_shell/share.sh
. $dir_shell/api.sh

## 导入配置文件，检测平台，创建软连接，识别命令，修复配置文件
detect_termux
detect_macos
link_shell
define_cmd
fix_config
import_config_no_check "update"
get_token

## 重置仓库remote url，docker专用，$1：要重置的目录，$2：要重置为的网址
reset_romote_url () {
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

## 克隆脚本，$1：仓库地址，$2：仓库保存路径，$3：分支（可省略）
git_clone_scripts () {
    local url=$1
    local dir=$2
    local branch=$3
    [[ $branch ]] && local cmd="-b $branch "
    echo -e "开始克隆仓库 $url 到 $dir\n"
    git clone $cmd $url $dir
    exit_status=$?
}

## 更新脚本，$1：仓库保存路径
git_pull_scripts () {
    local dir_current=$(pwd)
    local dir_work=$1
    cd $dir_work
    echo -e "开始更新仓库：$dir_work\n"
    git fetch --all
    exit_status=$?
    git reset --hard
    git pull
    cd $dir_current
}

## 生成脚本的路径清单文件
gen_list_own () {
    local dir_current=$(pwd)
    rm -f $dir_list_tmp/own*.list >/dev/null 2>&1
    for ((i=0; i<${#array_own_scripts_path[*]}; i++)); do
        cd ${array_own_scripts_path[i]}
        if [[ $(ls *.js 2>/dev/null) ]]; then
            for file in $(ls *.js); do
                if [ -f $file ]; then
                    perl -ne "{
                        print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*\/?$file/
                    }" $file | \
                    perl -pe "{
                        s|.*(([\d\*]*[\*-\/,\d]*[\d\*] ){4}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$file.*|${array_own_scripts_path[i]}/$file|g;
                        s|$dir_scripts/||
                    }" | head -1 >> $list_own_scripts
                fi
            done
        fi
    done
    grep -E "$cmd_task " $list_crontab_user | perl -pe "s|.* $cmd_task ([^\s]+)( .+\|$)|\1|" | sort -u > $list_own_user
    cd $dir_current
}

## 检测cron的差异，$1：脚本清单文件路径，$2：cron任务清单文件路径，$3：增加任务清单文件路径，$4：删除任务清单文件路径
diff_cron () {
    make_dir $dir_list_tmp
    local list_scripts="$1"
    local list_task="$2"
    local list_add="$3"
    local list_drop="$4"
    if [ -s $list_task ]; then
        grep -vwf $list_task $list_scripts > $list_add
    elif [ ! -s $list_task ] && [ -s $list_scripts ]; then
        cp -f $list_scripts $list_add
    fi
    if [ -s $list_scripts ]; then
        grep -vwf $list_scripts $list_task > $list_drop
    else
        cp -f $list_task $list_drop
    fi
}

## 更新docker-entrypoint，docker专用
update_docker_entrypoint () {
    if [[ $QL_DIR ]] && [[ $(diff $dir_root/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh) ]]; then
        cp -f $dir_root/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
        chmod 777 /usr/local/bin/docker-entrypoint.sh
    fi
}

## 检测配置文件版本
detect_config_version () {
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
            [[ $? -eq 0 ]] && echo $ver_config_sample > $send_mark
        fi
    else
        [ -f $send_mark ] && rm -f $send_mark
    fi
}

## npm install 子程序，判断是否为安卓，判断是否安装有yarn
npm_install_sub () {
    local cmd_1 cmd_2
    type yarn >/dev/null 2>&1 && cmd_1=yarn || cmd_1=npm
    [[ $is_termux -eq 1 ]] && cmd_2="--no-bin-links" || cmd_2=""
    $cmd_1 install $cmd_2 --registry=https://registry.npm.taobao.org || $cmd_1 install $cmd_2
}

## npm install，$1：package.json文件所在路径
npm_install_1 () {
    local dir_current=$(pwd)
    local dir_work=$1

    cd $dir_work
    echo -e "运行 npm install...\n"
    npm_install_sub
    [[ $? -ne 0 ]] && echo -e "\nnpm install 运行不成功，请进入 $dir_work 目录后手动运行 npm install...\n"
    cd $dir_current
}

npm_install_2 () {
    local dir_current=$(pwd)
    local dir_work=$1

    cd $dir_work
    echo -e "检测到 $dir_work 的依赖包有变化，运行 npm install...\n"
    npm_install_sub
    [[ $? -ne 0 ]] && echo -e "\n安装 $dir_work 的依赖包运行不成功，再次尝试一遍...\n"
    npm_install_1 $dir_work
    cd $dir_current
}

## 比对两个文件，$1比$2新时，将$1复制为$2
diff_and_copy () {
    local copy_source=$1
    local copy_to=$2
    if [ ! -s $copy_to ] || [[ $(diff $copy_source $copy_to) ]]; then
        cp -f $copy_source $copy_to
    fi
}

## 更新依赖
update_depend () {
    if [ ! -s $dir_scripts/package.json ] || [[ $(diff $dir_sample/package.json $dir_scripts/package.json) ]]; then
        cp -f $dir_sample/package.json $dir_scripts/package.json
        npm_install_2 $dir_scripts
    fi

    [ ! -d $dir_scripts/node_modules ] && npm_install_2 $dir_scripts

    diff_and_copy "$dir_sample/sendNotify.js" "$dir_scripts/sendNotify.js"
    diff_and_copy "$dir_sample/jdCookie.js" "$dir_scripts/jdCookie.js"
}

## 输出是否有新的或失效的定时任务，$1：新的或失效的任务清单文件路径，$2：新/失效
output_list_add_drop () {
    local list=$1
    local type=$2
    if [ -s $list ]; then
        echo -e "检测到有$type的定时任务：\n"
        cat $list
        echo
    fi
}

## 自动删除失效的脚本与定时任务，需要：1.AutoDelCron/AutoDelCron 设置为 true；2.正常更新js脚本，没有报错；3.存在失效任务；4.crontab.list存在并且不为空
## $1：失效任务清单文件路径
del_cron () {
    local list_drop=$1
    local detail detail2
    if [ -s $list_drop ] && [ -s $list_crontab_user ]; then
        detail=$(cat $list_drop)     
        echo -e "开始尝试自动删除失效的定时任务...\n"
        for cron in $detail; do
            local id=$(cat $list_crontab_user | grep -E "$cmd_task $cron" | perl -pe "s|.*ID=(.*) $cmd_task $cron|\1|")
            del_cron_api "$id"
        done
        detail2=$(echo $detail | perl -pe "s| |\\\n|g")
        echo -e "成功删除失效的的定时任务...\n"
        notify "删除失效任务通知" "成功删除以下失效的定时任务：\n$detail2"
    fi
}

## 自动增加定时任务，需要：1.AutoAddCron 设置为 true；2.正常更新js脚本，没有报错；3.存在新任务；4.crontab.list存在并且不为空
## $1：新任务清单文件路径
add_cron () {
    local list_add=$1
    local list_crontab_own_tmp=$dir_list_tmp/crontab_own.list

    [ -f $list_crontab_own_tmp ] && rm -f $list_crontab_own_tmp

    if [ -s $list_crontab_user ]; then
        echo -e "开始尝试自动添加定时任务...\n"
        local detail=$(cat $list_add)
        cd $dir_scripts
        for file_relative_path in $detail; do
            local file_name=$(echo $file_relative_path | awk -F "/" '{print $NF}')
            if [ -f $file_relative_path ]; then
                cron_line=$(
                    perl -ne "{
                        print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*$file_name/
                    }" $file_relative_path | \
                    perl -pe "{
                        s|[^\d\*]*(([\d\*]*[\*-\/,\d]*[\d\*] ){4}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$file_name.*|\1:$cmd_task $file_relative_path|g;
                        s|  | |g
                    }" | sort -u | head -1
                )
                cron_name=$(grep "new Env" $file_relative_path | awk -F "'|\"" '{print $2}' | head -1)
                [[ -z $cron_name ]] && cron_name="$file_name"
                add_cron_api "$cron_line:$cron_name"
            fi
        done
        exit_status=$?
        local detail2=$(echo $detail | perl -pe "s| |\\\n|g")
        if [[ $exit_status -eq 0 ]]; then
            crontab $list_crontab_user
            echo -e "成功添加新的定时任务...\n"
            notify "新增任务通知" "成功添加新的定时任务：\n$detail2"
        else
            echo -e "添加新的定时任务出错，请手动添加...\n"
            notify "新任务添加失败通知" "尝试自动添加以下新的定时任务出错，请手动添加：\n$detail2"
        fi
    fi

    [ -f $list_crontab_own_tmp ] && rm -f $list_crontab_own_tmp
}

## 更新所有仓库
update_own_repo () {
    [[ ${#array_own_repo_url[*]} -gt 0 ]] && echo -e "--------------------------------------------------------------\n"
    for ((i=0; i<${#array_own_repo_url[*]}; i++)); do
        if [ -d ${array_own_repo_path[i]}/.git ]; then
            reset_romote_url ${array_own_repo_path[i]} ${array_own_repo_url[i]}
            git_pull_scripts ${array_own_repo_path[i]}
        else
            git_clone_scripts ${array_own_repo_url[i]} ${array_own_repo_path[i]} ${array_own_repo_branch[i]}
        fi
        if [[ $exit_status -eq 0 ]]; then
            echo -e "\n更新${array_own_repo_path[i]}成功...\n"
            diff_and_copy "$dir_sample/sendNotify.js" "${array_own_repo_path[i]}/sendNotify.js"
            diff_and_copy "$dir_sample/jdCookie.js" "${array_own_repo_path[i]}/jdCookie.js"
        else
            echo -e "\n更新${array_own_repo_path[i]}失败，请检查原因...\n"
        fi
    done
    for ((i=0; i<${#array_own_scripts_path[*]}; i++)); do
        diff_and_copy "$dir_sample/sendNotify.js" "${array_own_scripts_path[i]}/sendNotify.js"
        diff_and_copy "$dir_sample/jdCookie.js" "${array_own_scripts_path[i]}/jdCookie.js"
    done
}

## 更新所有 raw 文件
update_own_raw () {
    if [[ ${#RawUrl[*]} -gt 0 ]]; then
        echo -e "--------------------------------------------------------------\n"
        make_dir $dir_raw
        diff_and_copy "$dir_sample/sendNotify.js" "$dir_raw/sendNotify.js"
        diff_and_copy "$dir_sample/jdCookie.js" "$dir_raw/jdCookie.js"
        for ((i=0; i<${#RawUrl[*]}; i++)); do
            raw_file_name[$i]=$(echo ${RawUrl[i]} | awk -F "/" '{print $NF}')
            echo -e "开始下载：${RawUrl[i]} \n\n保存路径：$dir_raw/${raw_file_name[$i]}\n"
            wget -q --no-check-certificate -O "$dir_raw/${raw_file_name[$i]}.new" ${RawUrl[i]}
            if [[ $? -eq 0 ]]; then
                mv "$dir_raw/${raw_file_name[$i]}.new" "$dir_raw/${raw_file_name[$i]}"
                echo -e "下载 ${raw_file_name[$i]} 成功...\n"
            else
                echo -e "下载 ${raw_file_name[$i]} 失败，保留之前正常下载的版本...\n"
                [ -f "$dir_raw/${raw_file_name[$i]}.new" ] && rm -f "$dir_raw/${raw_file_name[$i]}.new"
            fi
        done
    fi

}

## 调用用户自定义的extra.sh
run_extra_shell () {
    if [[ ${EnableExtraShell} == true ]]; then
        if [ -f $file_extra_shell ]
        then
            echo -e "--------------------------------------------------------------\n"
            . $file_extra_shell
        else
            echo -e "$file_extra_shell文件不存在，跳过执行...\n"
        fi
    fi
}

## 脚本用法
usage () {
    echo -e "本脚本用法："
    echo -e "1. $cmd_update all       # 更新qinglong、所有你设置的仓库和raw文件，如果启用了EnableExtraShell还将在最后运行你自己编写的extra.sh"
    echo -e "2. $cmd_update ql        # 只更新qinglong，和输入 $cmd_update qinglong 时功能一样，不会运行extra.sh"
    echo -e "3. $cmd_update raw       # 只更新raw文件，不会运行extra.sh"
    echo -e "4. $cmd_update repo      # 更新所有设置的REPO，不会运行extra.sh"
    echo -e "5. $cmd_update <folder>  # 指定scripts脚本目录下某个文件夹名称，只更新这个文件夹中的脚本，当该文件夹已经存在并且是git仓库才可使用此命令，不会运行extra.sh"
}

## 更新qinglong
update_qinglong () {
    echo -e "--------------------------------------------------------------\n"
    git_pull_scripts $dir_root
    if [[ $exit_status -eq 0 ]]; then
        echo -e "\n更新$dir_root成功...\n"
        make_dir $dir_config
        cp -f $file_config_sample $dir_config/config.sample.sh
        update_docker_entrypoint
        update_depend
        detect_config_version
    else
        echo -e "\n更新$dir_root失败，请检查原因...\n"
    fi
}

## 更新所有脚本
update_all_scripts () {
    count_own_repo_sum
    gen_own_dir_and_path
    if [[ ${#array_own_scripts_path[*]} -gt 0 ]]; then
        update_own_repo
        update_own_raw
        gen_list_own
        diff_cron $list_own_scripts $list_own_user $list_own_add $list_own_drop

        if [ -s $list_own_drop ]; then
            output_list_add_drop $list_own_drop "失效"
            [[ ${AutoDelCron} == true ]] && del_cron $list_own_drop
        fi
        if [ -s $list_own_add ]; then
            output_list_add_drop $list_own_add "新"
            if [[ ${AutoAddCron} == true ]]; then
                add_cron $list_own_add
            fi
        fi
    fi
}

## 更新指定仓库
update_specify_scripts_repo () {
    local tmp_dir=$1
    if [ -d $dir_scripts/$tmp_dir ]; then
        if [ -d $dir_scripts/$tmp_dir/.git ]; then
            git_pull_scripts $dir_scripts/$tmp_dir
        else
            echo -e "$dir_scripts/$tmp_dir 不是一个git仓库...\n"
        fi
    else
        echo -e "$dir_scripts/$tmp_dir 还不存在，可能是还没有clone？\n"
        usage
    fi
}

main () {
    local p1=$1
    log_time=$(date "+%Y-%m-%d-%H-%M-%S")
    log_path="$dir_log/update/${log_time}_$p1.log"
    make_dir "$dir_log/update"
    if [[ $# -ne 1 ]]; then
        echo -e "命令输入错误...\n"
        usage
    else
        case $p1 in
            all)
                update_qinglong | tee $log_path
                update_all_scripts | tee -a $log_path
                run_extra_shell | tee -a $log_path
                ;;
            ql | qinglong)
                update_qinglong | tee $log_path
                ;;
            repo)
                count_own_repo_sum
                gen_own_dir_and_path
                update_own_repo | tee $log_path
                ;;
            raw)
                count_own_repo_sum
                gen_own_dir_and_path
                update_own_raw | tee $log_path
                ;;
            *)
                update_specify_scripts_repo "$p1" | tee $log_path
                ;;
        esac
    fi
}

main "$@"

exit 0