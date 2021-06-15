#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

## 组合Cookie和互助码子程序，$1：要组合的内容
combine_sub() {
    local what_combine=$1
    local combined_all=""
    local tmp1 tmp2
    for ((i = 1; i <= $user_sum; i++)); do
        for num in $block_cookie; do
            [[ $i -eq $num ]] && continue 2
        done
        local tmp1=$what_combine$i
        local tmp2=${!tmp1}
        combined_all="$combined_all&$tmp2"
    done
    echo $combined_all | perl -pe "{s|^&||; s|^@+||; s|&@|&|g; s|@+&|&|g; s|@+|@|g; s|@+$||}"
}

## 正常依次运行时，组合所有账号的Cookie与互助码
combine_all() {
    for ((i = 0; i < ${#env_name[*]}; i++)); do
        result=$(combine_sub ${var_name[i]})
        if [[ $result ]]; then
            export ${env_name[i]}="$result"
        fi
    done
}

## 并发运行时，直接申明每个账号的Cookie与互助码，$1：用户Cookie编号
combine_one() {
    local user_num=$1
    for ((i = 0; i < ${#env_name[*]}; i++)); do
        local tmp=${var_name[i]}$user_num
        export ${env_name[i]}=${!tmp}
    done
}

## 选择python3还是node
define_program() {
    local p1=$1
    if [[ $p1 == *.js ]]; then
        which_program="node"
    elif [[ $p1 == *.py ]]; then
        which_program="python3"
    else
        which_program=""
    fi
}

random_delay() {
    local random_delay_max=$RandomDelay
    if [[ $random_delay_max ]] && [[ $random_delay_max -gt 0 ]]; then
        local current_min=$(date "+%-M")
        if [[ $current_min -ne 0 ]] && [[ $current_min -ne 30 ]]; then
            delay_second=$(($(gen_random_num $random_delay_max) + 1))
            echo -e "\n命令未添加 \"now\"，随机延迟 $delay_second 秒后再执行任务，如需立即终止，请按 CTRL+C...\n"
            sleep $delay_second
        fi
    fi
}

## scripts目录下所有可运行脚本数组
gen_array_scripts() {
    local dir_current=$(pwd)
    local i="-1"
    cd $dir_scripts
    for file in $(ls); do
        if [ -f $file ] && [[ $file == *.js && $file != sendNotify.js ]]; then
            let i++
            array_scripts[i]=$(echo "$file" | perl -pe "s|$dir_scripts/||g")
            array_scripts_name[i]=$(grep "new Env" $file | awk -F "'|\"" '{print $2}' | head -1)
            [[ -z ${array_scripts_name[i]} ]] && array_scripts_name[i]="<未识别出活动名称>"
        fi
    done
    cd $dir_current
}

## 使用说明
usage() {
    define_cmd
    gen_array_scripts
    echo -e "task命令运行本程序自动添加进crontab的脚本，需要输入脚本的绝对路径或去掉 “$dir_scripts/” 目录后的相对路径（定时任务中请写作相对路径），用法为："
    echo -e "1.$cmd_task <file_name>        # 依次执行，如果设置了随机延迟，将随机延迟一定秒数"
    echo -e "2.$cmd_task <file_name> now    # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中"
    echo -e "3.$cmd_task <file_name> conc   # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中"
    if [[ ${#array_scripts[*]} -gt 0 ]]; then
        echo -e "\n当前有以下脚本可以运行:"
        for ((i = 0; i < ${#array_scripts[*]}; i++)); do
            echo -e "$(($i + 1)). ${array_scripts_name[i]}：${array_scripts[i]}"
        done
    else
        echo -e "\n暂无脚本可以执行"
    fi
}

## run nohup，$1：文件名，不含路径，带后缀
run_nohup() {
    local file_name=$1
    nohup node $file_name &>$log_path &
}

## 正常运行单个脚本，$1：传入参数
run_normal() {
    local p1=$1
    cd $dir_scripts
    define_program "$p1"
    if [[ $p1 == *.js ]]; then
        if [[ $AutoHelpOther == true ]] && [[ $(ls $dir_code) ]]; then
            local latest_log=$(ls -r $dir_code | head -1)
            . $dir_code/$latest_log
        fi
        if [[ $# -eq 1 ]]; then
            random_delay
        fi
    fi
    combine_all
    log_time=$(date "+%Y-%m-%d-%H-%M-%S")
    log_dir_tmp="${p1##*/}"
    log_dir="$dir_log/${log_dir_tmp%%.*}"
    log_path="$log_dir/$log_time.log"
    make_dir "$log_dir"

    local id=$(cat $list_crontab_user | grep -E "$cmd_task $p1$" | perl -pe "s|.*ID=(.*) $cmd_task $p1$|\1|" | xargs | sed 's/ /","/g')
    update_cron_status "\"$id\"" "0"
    timeout $command_timeout_time $which_program $p1 2>&1 | tee $log_path
    update_cron_status "\"$id\"" "1"
}

## 并发执行，因为是并发，所以日志只能直接记录在日志文件中（日志文件以Cookie编号结尾），前台执行并发跑时不会输出日志
## 并发执行时，设定的 RandomDelay 不会生效，即所有任务立即执行
run_concurrent() {
    local p1=$1
    cd $dir_scripts
    define_program "$p1"
    log_dir="$dir_log/${p1%%.*}"
    make_dir $log_dir
    log_time=$(date "+%Y-%m-%d-%H-%M-%S.%N")
    echo -e "\n各账号间已经在后台开始并发执行，前台不输入日志，日志直接写入文件中。\n"
    for ((user_num = 1; user_num <= $user_sum; user_num++)); do
        combine_one $user_num
        log_path="$log_dir/${log_time}_${user_num}.log"
        timeout $command_timeout_time $which_program $p1 &>$log_path &
    done
}

## 运行其他命令
run_else() {
    local log_time=$(date "+%Y-%m-%d-%H-%M-%S")
    local log_dir="$dir_log/$1"
    local log_path="$log_dir/$log_time.log"
    make_dir "$log_dir"
    timeout $command_timeout_time "$@" 2>&1 | tee $log_path
}

## 命令检测
main() {
    case $# in
    0)
        echo
        usage
        ;;
    1)
        run_normal $1
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
            run_else "$@"
            ;;
        esac
        ;;
    *)
        run_else "$@"
        ;;
    esac
}

main "$@"

exit 0
