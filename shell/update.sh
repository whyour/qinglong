#!/usr/bin/env bash

## 文件路径、脚本网址
dir_shell=$(dirname $(readlink -f "$0"))
dir_root=$(cd $dir_shell; cd ..; pwd)
send_mark=$dir_shell/send_mark

## 导入通用变量与函数
. $dir_shell/share.sh

## 导入配置文件，检测平台，创建软连接，识别命令，修复配置文件
detect_termux
detect_macos
link_shell
define_cmd
fix_config
import_config_no_check jup

## 更新crontab，gitee服务器同一时间限制5个链接，因此每个人更新代码必须错开时间，每次执行git_pull随机生成。
## 每天次数随机，更新时间随机，更新秒数随机，至少4次，至多6次，大部分为5次，符合正态分布。
random_update_jup_cron () {
    if [[ $(date "+%-H") -le 4 ]] && [ -f $list_crontab_user ]; then
        local random_min=$(gen_random_num 60)
        local random_sleep=$(gen_random_num 56)
        local random_hour_array[0]=$(gen_random_num 5)
        local random_hour=${random_hour_array[0]}
        local i j tmp

        for ((i=1; i<14; i++)); do
            j=$(($i - 1))
            tmp=$(($(gen_random_num 3) + ${random_hour_array[j]} + 4))
            [[ $tmp -lt 24 ]] && random_hour_array[i]=$tmp || break
        done

        for ((i=1; i<${#random_hour_array[*]}; i++)); do
            random_hour="$random_hour,${random_hour_array[i]}"
        done

        perl -i -pe "s|.+( $cmd_update)( .*\|$)|$random_min $random_hour \* \* \* sleep $random_sleep && \1|" $list_crontab_user
        crontab $list_crontab_user
    fi
}

## 重置仓库remote url，docker专用，$1：要重置的目录，$2：要重置为的网址
reset_romote_url () {
    local dir_current=$(pwd)
    local dir_work=$1
    local url=$2

    if [ -d "$dir/.git" ]; then
        cd $dir_work
        git remote set-url origin $url
        git reset --hard
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

## 统计 own 仓库数量
count_own_repo_sum () {
    if [[ -z ${RepoUrl1} ]]; then
        own_repo_sum=0
    else
        for ((i=1; i<=1000; i++)); do
            local tmp1=RepoUrl$i
            local tmp2=${!tmp1}
            [[ $tmp2 ]] && own_repo_sum=$i || break
        done
    fi
}

## 形成 own 仓库的文件夹名清单，依赖于import_config_and_check或import_config_no_check
## array_own_repo_path：repo存放的绝对路径组成的数组；array_own_scripts_path：所有要使用的脚本所在的绝对路径组成的数组
gen_own_dir_and_path () {
    local scripts_path_num="-1"
    local repo_num tmp1 tmp2 tmp3 tmp4 tmp5 dir
    
    if [[ $own_repo_sum -ge 1 ]]; then
        for ((i=1; i<=$own_repo_sum; i++)); do
            repo_num=$((i - 1))
            tmp1=RepoUrl$i
            array_own_repo_url[$repo_num]=${!tmp1}
            tmp2=RepoBranch$i
            array_own_repo_branch[$repo_num]=${!tmp2}
            array_own_repo_dir[$repo_num]=$(echo ${array_own_repo_url[$repo_num]} | perl -pe "s|.+com(/\|:)([\w-]+)/([\w-]+)(\.git)?|\2_\3|")
            array_own_repo_path[$repo_num]=$dir_scripts/${array_own_repo_dir[$repo_num]}
            tmp3=RepoPath$i
            if [[ ${!tmp3} ]]; then
                for dir in ${!tmp3}; do
                    let scripts_path_num++
                    tmp4="${array_own_repo_dir[repo_num]}/$dir"
                    tmp5=$(echo $tmp4 | perl -pe "{s|//|/|g; s|/$||}")  # 去掉多余的/
                    array_own_scripts_path[$scripts_path_num]="$dir_scripts/$tmp5"
                done
            else
                let scripts_path_num++
                array_own_scripts_path[$scripts_path_num]="${array_own_repo_path[$repo_num]}"
            fi
        done
    fi

    if [[ ${#RawUrl[*]} -ge 1 ]]; then
        let scripts_path_num++
        array_own_scripts_path[$scripts_path_num]=$dir_raw  # 只有own脚本所在绝对路径附加了raw文件夹，其他数组均不附加
    fi
}

## 生成脚本的相对路径清单
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
    grep -E "$cmd_task " $list_crontab_user | perl -pe "s|.*$cmd_task ([^\s]+)( .+\|$)|\1|" | sort -u > $list_own_user
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
        echo -e "开始尝试自动删除$type2的定时任务...\n"
        for cron in $detail; do
            local tmp=$(echo $cron | perl -pe "s|/|\.|g")
            perl -i -ne "{print unless / $type $tmp( |$)/}" $list_crontab_user
        done
        crontab $list_crontab_user
        detail2=$(echo $detail | perl -pe "s| |\\\n|g")
        echo -e "成功删除失效的的定时任务...\n"
        notify "删除失效任务通知" "成功删除以下失效的定时任务：\n$detail2"
    fi
}

## 自动增加自己额外的脚本的定时任务，需要：1.AutoAddCron 设置为 true；2.正常更新js脚本，没有报错；3.存在新任务；4.crontab.list存在并且不为空
## $1：新任务清单文件路径
add_cron () {
    local list_add=$1
    local list_crontab_own_tmp=$dir_list_tmp/crontab_own.list

    [ -f $list_crontab_own_tmp ] && rm -f $list_crontab_own_tmp

    if [[ ${AutoAddCron} == true ]] && [ -s $list_add ] && [ -s $list_crontab_user ]; then
        echo -e "开始尝试自动添加 own 脚本的定时任务...\n"
        local detail=$(cat $list_add)
        for file_full_path in $detail; do
            local file_name=$(echo $file_full_path | awk -F "/" '{print $NF}')
            if [ -f $file_full_path ]; then
                perl -ne "{
                    print if /.*([\d\*]*[\*-\/,\d]*[\d\*] ){4}[\d\*]*[\*-\/,\d]*[\d\*]( |,|\").*$file_name/
                }" $file_full_path | \
                perl -pe "{
                    s|[^\d\*]*(([\d\*]*[\*-\/,\d]*[\d\*] ){4}[\d\*]*[\*-\/,\d]*[\d\*])( \|,\|\").*/?$file_name.*|\1 $cmd_task $file_full_path|g;
                    s|  | |g;
                    s|$dir_scripts||
                }" | sort -u | head -1 >> $list_crontab_own_tmp
            fi
        done
        cat $list_crontab_own_tmp >> $list_crontab_user
        exit_status=$?
    fi

    [ -f $list_crontab_own_tmp ] && rm -f $list_crontab_own_tmp
}

## 向系统添加定时任务以及通知，$1：写入crontab.list时的exit状态，$2：新增清单文件路径，$3：jd_scripts脚本/own脚本
add_cron_notify () {
    local status_code=$1
    local list_add=$2
    local tmp=$(echo $(cat $list_add))
    local detail=$(echo $tmp | perl -pe "s| |\\\n|g")
    local type=$3
    if [[ $status_code -eq 0 ]]; then
        crontab $list_crontab_user
        echo -e "成功添加新的定时任务...\n"
        notify "新增任务通知" "成功添加新的定时任务（$type）：\n$detail"
    else
        echo -e "添加新的定时任务出错，请手动添加...\n"
        notify "新任务添加失败通知" "尝试自动添加以下新的定时任务出错，请手动添加（$type）：\n$detail"
    fi
}

## 更新所有仓库
update_own_repo () {
    [[ ${#array_own_repo_url[*]} -gt 0 ]] && echo -e "--------------------------------------------------------------\n"
    for ((i=0; i<${#array_own_repo_url[*]}; i++)); do
        if [ -d ${array_own_repo_path[i]}/.git ]; then
            git_pull_scripts ${array_own_repo_path[i]}
        else
            git_clone_scripts ${array_own_repo_url[i]} ${array_own_repo_path[i]} ${array_own_repo_branch[i]}
        fi
        [[ $exit_status -eq 0 ]] && echo -e "\n更新${array_own_repo_path[i]}成功...\n" || echo -e "\n更新${array_own_repo_path[i]}失败，请检查原因...\n"
    done
}

## 更新所有 raw 文件
update_own_raw () {
    local rm_mark
    [[ ${#RawUrl[*]} -gt 0 ]] && echo -e "--------------------------------------------------------------\n"
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

    for file in $(ls $dir_raw); do
        rm_mark="yes"
        for ((i=0; i<${#raw_file_name[*]}; i++)); do
            if [[ $file == ${raw_file_name[$i]} ]]; then
                rm_mark="no"
                break
            fi
        done
        [[ $rm_mark == yes ]] && rm -f $dir_raw/$file 2>/dev/null
    done
}

## 调用用户自定义的diy.sh
run_diy_shell () {
    if [[ ${EnableExtraShell} == true ]]; then
        if [ -f $file_diy_shell ]
        then
            echo -e "--------------------------------------------------------------\n"
            . $file_diy_shell
        else
            echo -e "$file_diy_shell文件不存在，跳过执行DIY脚本...\n"
        fi
    fi
}

## 在日志中记录时间与路径
record_time_in_log () {
    echo "
--------------------------------------------------------------

系统时间：$(date "+%Y-%m-%d %H:%M:%S")

根目录：$dir_root

scripts目录：$dir_scripts

--------------------------------------------------------------
"
}

#################################################################################################################################



## 更新jup任务的cron
random_update_jup_cron

## 重置仓库romote url
if [[ $QL_DIR ]] && [[ $ENABLE_RESET_REPO_URL == true ]]; then
    reset_romote_url $dir_shell $url_shell >/dev/null
    reset_romote_url $dir_scripts $url_scripts >/dev/null
fi

## 更新shell
git_pull_scripts $dir_shell
if [[ $exit_status -eq 0 ]]; then
    echo -e "\n更新$dir_shell成功...\n"
    make_dir $dir_config
    cp -f $file_config_sample $dir_config/config.sample.sh
    update_docker_entrypoint
    update_bot_py
    detect_config_version
else
    echo -e "\n更新$dir_shell失败，请检查原因...\n"
fi

## 更新scripts
## 更新前先存储package.json和githubAction.md的内容
[ -f $dir_scripts/package.json ] && scripts_depend_old=$(cat $dir_scripts/package.json)
[ -f $dir_scripts/githubAction.md ] && cp -f $dir_scripts/githubAction.md $dir_list_tmp/githubAction.md

## 更新或克隆scripts
if [ -d $dir_scripts/.git ]; then
    git_pull_scripts $dir_scripts
else
    git_clone_scripts $url_scripts $dir_scripts
fi

if [[ $exit_status -eq 0 ]]; then
    echo -e "\n更新$dir_scripts成功...\n"

    ## npm install
    [ ! -d $dir_scripts/node_modules ] && npm_install_1 $dir_scripts
    [ -f $dir_scripts/package.json ] && scripts_depend_new=$(cat $dir_scripts/package.json)
    [[ "$scripts_depend_old" != "$scripts_depend_new" ]] && npm_install_2 $dir_scripts
    
    ## diff cron
    gen_list_task
    diff_cron $list_task_jd_scripts $list_task_user $list_task_add $list_task_drop

    ## 失效任务通知
    if [ -s $list_task_drop ]; then
        output_list_add_drop $list_task_drop "失效"
        [[ ${AutoDelCron} == true ]] && del_cron $list_task_drop jtask
    fi

    ## 新增任务通知
    if [ -s $list_task_add ]; then
        output_list_add_drop $list_task_add "新"
        add_cron_jd_scripts $list_task_add
        [[ ${AutoAddCron} == true ]] && add_cron_notify $exit_status $list_task_add "jd_scripts脚本"
    fi

    ## 环境变量变化通知
    echo -e "检测环境变量清单文件 $dir_scripts/githubAction.md 是否有变化...\n"
    diff $dir_list_tmp/githubAction.md $dir_scripts/githubAction.md | tee $dir_list_tmp/env.diff
    if [ ! -s $dir_list_tmp/env.diff ]; then
        echo -e "$dir_scripts/githubAction.md 没有变化...\n"
    elif [ -s $dir_list_tmp/env.diff ] && [[ ${EnvChangeNotify} == true ]]; then
        notify_title="检测到环境变量清单文件有变化"
        notify_content="减少的内容：\n$(grep -E '^-[^-]' $dir_list_tmp/env.diff)\n\n增加的内容：\n$(grep -E '^\+[^\+]' $dir_list_tmp/env.diff)"
        notify "$notify_title" "$notify_content"
    fi
else
    echo -e "\n更新$dir_scripts失败，请检查原因...\n"
fi

## 更新own脚本
count_own_repo_sum
gen_own_dir_and_path
if [[ ${#array_own_scripts_path[*]} -gt 0 ]]; then
    make_dir $dir_raw
    update_own_repo
    update_own_raw
    gen_list_own
    diff_cron $list_own_scripts $list_own_user $list_own_add $list_own_drop

    if [ -s $list_own_drop ]; then
        output_list_add_drop $list_own_drop "失效"
        [[ ${AutoDelCron} == true ]] && del_cron $list_own_drop otask
    fi
    if [ -s $list_own_add ]; then
        output_list_add_drop $list_own_add "新"
        add_cron $list_own_add
        [[ ${AutoAddCron} == true ]] && add_cron_notify $exit_status $list_own_add "own脚本"
    fi
else
    perl -i -ne "{print unless / $cmd_task /}" $list_crontab_user
fi



exit 0
