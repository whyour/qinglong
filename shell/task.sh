#!/usr/bin/env bash

## 路径
dir_shell=$(dirname $(readlink -f "$0"))
dir_root=$(cd $dir_shell; cd ..; pwd)

## 导入通用变量与函数
. $dir_shell/share.sh

## 更新crontab
update_crontab () {
    if [[ $(cat $list_crontab_user) != $(crontab -l) ]]; then
        crontab $list_crontab_user
    fi
}

## 组合Cookie和互助码子程序，$1：要组合的内容
combine_sub () {
    local what_combine=$1
    local combined_all=""
    local tmp1 tmp2
    for ((i=1; i<=$user_sum; i++)); do
        for num in $TempBlockCookie; do
            [[ $i -eq $num ]] && continue 2
        done
        local tmp1=$what_combine$i
        local tmp2=${!tmp1}
        combined_all="$combined_all&$tmp2"
    done
    echo $combined_all | perl -pe "{s|^&||; s|^@+||; s|&@|&|g; s|@+&|&|g; s|@+|@|g; s|@+$||}"
}

## 正常依次运行时，组合所有账号的Cookie与互助码
combine_all () {
    for ((i=0; i<${#env_name[*]}; i++)); do
        export ${env_name[i]}=$(combine_sub ${var_name[i]})
    done
}

## 并发运行时，直接申明每个账号的Cookie与互助码，$1：用户Cookie编号
combine_one () {
    local user_num=$1
    for ((i=0; i<${#env_name[*]}; i++)); do
        local tmp=${var_name[i]}$user_num
        export ${env_name[i]}=${!tmp}
    done
}

## 转换JD_BEAN_SIGN_STOP_NOTIFY或JD_BEAN_SIGN_NOTIFY_SIMPLE
trans_JD_BEAN_SIGN_NOTIFY () {
    case ${NotifyBeanSign} in
        0)
            export JD_BEAN_SIGN_STOP_NOTIFY="true"
            ;;
        1)
            export JD_BEAN_SIGN_NOTIFY_SIMPLE="true"
            ;;
        2)
            export JD_BEAN_SIGN_NOTIFY_SIMPLE="false"
            ;;
    esac
}

## 转换UN_SUBSCRIBES
trans_UN_SUBSCRIBES () {
    export UN_SUBSCRIBES="${goodPageSize}\n${shopPageSize}\n${jdUnsubscribeStopGoods}\n${jdUnsubscribeStopShop}"
}

## 申明全部变量，$1：all/Cookie编号
export_all_env () {
    local type=$1
    local latest_log
    if [[ $AutoHelpOther == true ]] && [[ $(ls $dir_code) ]]; then
        latest_log=$(ls -r $dir_code | head -1)
        . $dir_code/$latest_log
    fi
    [ -f $file_sharecode ] && . $file_sharecode
    [[ $type == all ]] && combine_all || combine_one $type
    trans_JD_BEAN_SIGN_NOTIFY
    trans_UN_SUBSCRIBES
}

random_delay () {
    local random_delay_max=$RandomDelay
    if [[ $random_delay_max ]] && [[ $random_delay_max -gt 0 ]]; then
        local current_min=$(date "+%-M")
        if [[ $current_min -gt 2 && $current_min -lt 30 ]] || [[ $current_min -gt 31 && $current_min -lt 59 ]]; then
            delay_second=$(($(gen_random_num $random_delay_max) + 1))
            echo -e "\n命令未添加 \"now\"，随机延迟 $delay_second 秒后再执行任务，如需立即终止，请按 CTRL+C...\n"
            sleep $delay_second
        fi
    fi
}

## scripts目录下所有可运行脚本数组
gen_array_scripts () {
    local dir_current=$(pwd)
    local i=0
    cd $dir_scripts
    for file in $(ls); do
        if [ -f $file ] && [[ $(grep "new Env" $file) ]] && [[ $file == *.js && $file != sendNotify.js && $file != JD_extra_cookie.js ]]; then
            array_scripts[i]=$file
            array_scripts_name[i]=$(grep "new Env" $file | awk -F "'|\"" '{print $2}' | head -1)
            [[ -z ${array_scripts_name[i]} ]] && array_scripts_name[i]="<未识别出活动名称>"
            let i++
        fi
    done
    cd $dir_current
}

## 使用说明
usage () {
    define_cmd
    gen_array_scripts
    echo -e "jtask命令运行 jd_scripts 脚本，如果已经将非 jd_scripts 脚本复制到 scripts 目录下，也可以使用此命令，用法为："
    echo -e "1.$cmd_jtask <js_name>        # 依次执行，如果设置了随机延迟并且当时时间不在0-2、30-31、59分内，将随机延迟一定秒数"
    echo -e "2.$cmd_jtask <js_name> now    # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中"
    echo -e "3.$cmd_jtask <js_name> conc   # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中"
    echo -e "4.$cmd_jtask runall           # 依次运行所有jd_scripts中的非挂机脚本，非常耗时"
    echo -e "5.$cmd_jtask hangup           # 重启挂机程序"
    echo -e "\notask命令运行 own 脚本，需要输入脚本的绝对路径或相对路径（定时任务中必须是绝对路径），otask会将该脚本复制到 scripts 目录下再运行，用法为："
    echo -e "1.$cmd_otask <js_path>        # 依次执行，如果设置了随机延迟并且当时时间不在0-2、30-31、59分内，将随机延迟一定秒数"
    echo -e "2.$cmd_otask <js_path> now    # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中"
    echo -e "3.$cmd_otask <js_path> conc   # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中"
    echo -e "\nmtask命令运行你自己添加的脚本，用法同jtask，如果脚本不在scripts目录下，则需要输入完整路径（同otask）。jtask otask mtask均为同一脚本的不同名字，三者仅用来在crontab.list中区分不同类型的任务，以方便自动增删任务，手动运行直接运行jtask即可。"
    echo -e "\n当前scripts目录下有以下脚本可以运行："
    for ((i=0; i<${#array_scripts[*]}; i++)); do
        echo -e "$(($i + 1)).${array_scripts_name[i]}：${array_scripts[i]}"
    done
}

## run nohup，$1：文件名，不含路径，带后缀
run_nohup () {
    local file_name=$1
    nohup node $file_name &>$log_path &
}

## 查找脚本路径与准确的文件名，$1：脚本传入的参数，输出的file_name不带后缀.js
find_file_and_path () {
    local para=$1
    local file_name_tmp1=$(echo $para | perl -pe "s|\.js||")
    local file_name_tmp2=$(echo $para | perl -pe "{s|jd_||; s|\.js||; s|^|jd_|}")
    local seek_path="$dir_scripts $dir_scripts/backUp"
    file_name=""
    which_path=""

    for path in $seek_path; do
        if [ -f $path/$file_name_tmp1.js ]; then
            file_name=$file_name_tmp1
            which_path=$path
            break
        elif [ -f $path/$file_name_tmp2.js ]; then
            file_name=$file_name_tmp2
            which_path=$path
            break
        fi
    done

    if [ -f $para ]; then
        local file_name_tmp3=$(echo $para | awk -F "/" '{print $NF}' | perl -pe "s|\.js||")
        if [[ $(grep -E "^$file_name_tmp3$" $list_task_jd_scripts) ]]; then
            echo -e "\njd_scripts项目存在同名文件$file_name_tmp3.js，不复制$para，直接执行$dir_scripts/$file_name_tmp3.js ...\n"
        else
            echo -e "\n复制 $para 到 $dir_scripts 下，并执行...\n"
            cp -f $para $dir_scripts
        fi
        file_name=$file_name_tmp3
        which_path=$dir_scripts
    fi
}

## 运行挂机脚本
run_hungup () {
    local hangup_file="jd_crazy_joy_coin"
    cd $dir_scripts
    for file in $hangup_file; do
        import_config_and_check $file
        count_user_sum
        export_all_env all
        if type pm2 >/dev/null 2>&1; then
            pm2 stop $file.js 2>/dev/null
            pm2 flush
            pm2 start -a $file.js --watch "$dir_scripts/$file.js" --name=$file
        else
            if [[ $(ps -ef | grep "$file" | grep -v "grep") != "" ]]; then
                ps -ef | grep "$file" | grep -v "grep" | awk '{print $2}' | xargs kill -9
            fi
            make_dir $dir_log/$file
            log_time=$(date "+%Y-%m-%d-%H-%M-%S")
            log_path="$dir_log/$file/$log_time.log"
            run_nohup $file.js >/dev/null 2>&1
        fi
    done
}

## 一次性运行所有jd_scripts脚本
run_all_jd_scripts () {
    define_cmd
    if [ ! -f $list_task_jd_scripts ]; then
        cat $list_crontab_jd_scripts | grep -E "j[drx]_\w+\.js" | perl -pe "s|.+(j[drx]_\w+)\.js.+|\1|" | sort -u > $list_task_jd_scripts
    fi
    echo -e "\n==================== 开始运行所有非挂机脚本 ====================\n"
    echo -e "请注意：本过程将非常非常耗时，一个账号可能长达几小时，账号越多耗时越长，如果是手动运行，退出终端也将终止运行。\n"
    echo -e "倒计时5秒...\n"
    for ((sec=5; sec>0; sec--)); do
        echo -e "$sec...\n"
        sleep 1
    done
    for file in $(cat $list_task_jd_scripts); do
        echo -e "==================== 运行 $file.js 脚本 ====================\n"
        $cmd_jtask $file now
    done
}

## 正常运行单个脚本，$1：传入参数
run_normal () {
    local p=$1
    find_file_and_path $p
    if [[ $file_name ]] && [[ $which_path ]]; then
        import_config_and_check "$file_name"
        update_crontab
        count_user_sum
        export_all_env all
        [[ $# -eq 1 ]] && random_delay
        [[ $user_sum -ge 60 ]] && rm -rf $dir_config/* &>/dev/null
        log_time=$(date "+%Y-%m-%d-%H-%M-%S")
        log_path="$dir_log/$file_name/$log_time.log"
        make_dir "$dir_log/$file_name"
        cd $which_path
        node $file_name.js 2>&1 | tee $log_path
    else
        echo -e "\n $p 脚本不存在，请确认...\n"
        usage
    fi
}

## 并发执行，因为是并发，所以日志只能直接记录在日志文件中（日志文件以Cookie编号结尾），前台执行并发跑时不会输出日志
## 并发执行时，设定的 RandomDelay 不会生效，即所有任务立即执行
run_concurrent () {
    local p=$1
    find_file_and_path $p
    if [[ $file_name ]] && [[ $which_path ]]; then
        import_config_and_check "$file_name"
        update_crontab
        count_user_sum
        [[ $user_sum -ge 60 ]] && rm -rf $dir_config/* &>/dev/null
        make_dir $dir_log/$file_name
        log_time=$(date "+%Y-%m-%d-%H-%M-%S.%N")
        echo -e "\n各账号间已经在后台开始并发执行，前台不输入日志，日志直接写入文件中。\n"
        for ((user_num=1; user_num<=$user_sum; user_num++)); do
            for num in ${TempBlockCookie}; do
                [[ $user_num -eq $num ]] && continue 2
            done
            export_all_env $user_num
            log_path="$dir_log/$file_name/${log_time}_${user_num}.log"
            cd $which_path
            node $file_name.js &>$log_path &
        done
    else
        echo -e "\n $p 脚本不存在，请确认...\n"
        usage
    fi
}

## 命令检测
case $# in
    0)
        echo
        usage
        ;;
    1)
        case $1 in
            hangup)
                run_hungup
                ;;
            runall)
                run_all_jd_scripts
                ;;
            *)
                run_normal $1
                ;;
        esac
        ;;
    2)
        case $2 in
            now)
                run_normal $1 $2
                ;;
            conc)
                run_concurrent $1 $2
                ;;
            *)
                echo -e "\n命令输入错误...\n"
                usage
                ;;
        esac
        ;;
    *)
        echo -e "\n命令过多...\n"
        usage
        ;;
esac
