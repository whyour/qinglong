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

## 选择python3还是node
define_program () {
    local p1=$1
    [[ $p1 == *.js ]] && which_program="node"
    [[ $p1 == *.py ]] && which_program="python3"
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
    import_config_no_check
    count_own_repo_sum
    gen_own_dir_and_path
    local dir_current=$(pwd)
    local i="-1"
    for ((scripts_path_num=0; scripts_path_num<${#array_own_scripts_path[*]}; scripts_path_num++)); do
        cd ${array_own_scripts_path[$scripts_path_num]}
        for file in $(ls); do
            if [ -f $file ] && [[ $(grep "new Env" $file) ]] && [[ $file == *.js && $file != sendNotify.js && $file != JD_extra_cookie.js ]]; then
                let i++
                array_scripts[i]=$(echo "${array_own_scripts_path[$scripts_path_num]}/$file" | perl -pe "s|$dir_scripts/||g")
                array_scripts_name[i]=$(grep "new Env" $file | awk -F "'|\"" '{print $2}' | head -1)
                [[ -z ${array_scripts_name[i]} ]] && array_scripts_name[i]="<未识别出活动名称>"
            fi
        done
    done
    cd $dir_current
}

## 使用说明
usage () {
    define_cmd
    gen_array_scripts
    echo -e "\ntask命令运行本程序自动添加进crontab的脚本，需要输入脚本的绝对路径或去掉 “$dir_scripts/” 目录后的相对路径（定时任务中请写作相对路径），用法为："
    echo -e "1.$cmd_task <js_path>        # 依次执行，如果设置了随机延迟并且当时时间不在0-2、30-31、59分内，将随机延迟一定秒数"
    echo -e "2.$cmd_task <js_path> now    # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中"
    echo -e "3.$cmd_task <js_path> conc   # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中"
    echo -e "\nmytask命令运行未识别出cron的脚本以及你自己添加的脚本，用法同task。mytask和task命令均为同一脚本的不同名字，二者仅用来在crontab.list中区分不同类型的任务，以方便自动增删任务，手动直接运行task即可。"
    echo -e "\n当前有以下脚本可以运行（已省略路径 “$dir_scripts/” ）："
    for ((i=0; i<${#array_scripts[*]}; i++)); do
        echo -e "$(($i + 1)). ${array_scripts_name[i]}：${array_scripts[i]}"
    done
}

## run nohup，$1：文件名，不含路径，带后缀
run_nohup () {
    local file_name=$1
    nohup node $file_name &>$log_path &
}

## 正常运行单个脚本，$1：传入参数
run_normal () {
    local p1=$1
    cd $dir_scripts
    if [ -f $p1 ]; then
        import_config_and_check "$p1"
        update_crontab
        define_program "$p1"
        combine_all
        [[ $# -eq 1 ]] && random_delay
        log_time=$(date "+%Y-%m-%d-%H-%M-%S")
        log_path="$dir_log/$p1/$log_time.log"
        make_dir "$dir_log/$p1"
        $which_program $p1 2>&1 | tee $log_path
    else
        update_crontab
        echo -e "\n $p1 脚本不存在，请确认...\n"
        usage
    fi
}

## 并发执行，因为是并发，所以日志只能直接记录在日志文件中（日志文件以Cookie编号结尾），前台执行并发跑时不会输出日志
## 并发执行时，设定的 RandomDelay 不会生效，即所有任务立即执行
run_concurrent () {
    local p1=$1
    cd $dir_scripts
    if [ -f $p1 ]; then
        import_config_and_check "$p1"
        update_crontab
        define_program
        make_dir $dir_log/$p1
        log_time=$(date "+%Y-%m-%d-%H-%M-%S.%N")
        echo -e "\n各账号间已经在后台开始并发执行，前台不输入日志，日志直接写入文件中。\n"
        for ((user_num=1; user_num<=$user_sum; user_num++)); do
            for num in ${TempBlockCookie}; do
                [[ $user_num -eq $num ]] && continue 2
            done
            combine_one $user_num
            log_path="$dir_log/$p1/${log_time}_${user_num}.log"
            $which_program $p1 &>$log_path &
        done
    else
        update_crontab
        echo -e "\n $p1 脚本不存在，请确认...\n"
        usage
    fi
}

## 命令检测
main () {
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
}

main "$@"