#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=$QL_DIR/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

## 选择python3还是node
define_program() {
    local file_param=$1
    if [[ $file_param == *.js ]]; then
        which_program="node"
    elif [[ $file_param == *.py ]] || [[ $file_param == *.pyc ]]; then
        which_program="python3"
    elif [[ $file_param == *.sh ]]; then
        which_program="bash"
    elif [[ $file_param == *.ts ]]; then
        which_program="ts-node-transpile-only"
    else
        which_program=""
    fi
}

random_delay() {
    local random_delay_max=$RandomDelay
    if [[ $random_delay_max ]] && [[ $random_delay_max -gt 0 ]]; then
        local file_param=$1
        local file_extensions=${RandomDelayFileExtensions-"js"}
        local ignored_minutes=${RandomDelayIgnoredMinutes-"0 30"}

        if [[ -n $file_extensions ]]; then
            if ! echo "$file_param" | grep -qE "\.${file_extensions// /$|\\.}$"; then
                # echo -e "\n当前文件需要准点运行, 放弃随机延迟\n"
                return
            fi
        fi

        local current_min
        current_min=$(date "+%-M")
        for minute in $ignored_minutes; do
            if [[ $current_min -eq $minute ]]; then
                # echo -e "\n当前时间需要准点运行, 放弃随机延迟\n"
                return
            fi
        done

        local delay_second=$(($(gen_random_num "$random_delay_max") + 1))
        echo -e "\n命令未添加 \"now\"，随机延迟 $delay_second 秒后再执行任务，如需立即终止，请按 CTRL+C...\n"
        sleep $delay_second
    fi
}

## scripts目录下所有可运行脚本数组
gen_array_scripts() {
    local dir_current=$(pwd)
    local i="-1"
    cd $dir_scripts
    for file in $(ls); do
        if [[ -f $file ]] && [[ $file == *.js && $file != sendNotify.js ]]; then
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
    echo -e "1.$cmd_task <file_name>                                             # 依次执行，如果设置了随机延迟，将随机延迟一定秒数"
    echo -e "2.$cmd_task <file_name> now                                         # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中"
    echo -e "3.$cmd_task <file_name> conc <环境变量名称> <账号编号，空格分隔>(可选的)  # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中，且可指定账号执行"
    echo -e "4.$cmd_task <file_name> desi <环境变量名称> <账号编号，空格分隔>         # 指定账号执行，无论是否设置了随机延迟，均立即运行"
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

handle_log_path() {
    define_program "$file_param"
    
    local suffix=""
    if [[ ! -z $ID ]]; then
        suffix="_${ID}"
    fi
    time=$(date "+$time_format")
    log_time=$(format_log_time "$time_format" "$time")
    log_dir_tmp="${file_param##*/}"
    if [[ $file_param =~ "/" ]]; then
        if [[ $file_param == /* ]]; then
            log_dir_tmp_path="${file_param:1}"
        else
            log_dir_tmp_path="${file_param}"
        fi
    fi
    log_dir_tmp_path="${log_dir_tmp_path%/*}"
    log_dir_tmp_path="${log_dir_tmp_path##*/}"
    [[ $log_dir_tmp_path ]] && log_dir_tmp="${log_dir_tmp_path}_${log_dir_tmp}"
    log_dir="${log_dir_tmp%.*}${suffix}"
    log_path="$log_dir/$log_time.log"
    cmd=">> $dir_log/$log_path 2>&1"
    [[ "$show_log" == "true" ]] && cmd=""
    make_dir "$dir_log/$log_dir"
}

## 正常运行单个脚本，$1：传入参数
run_normal() {
    local file_param=$1
    if [[ $# -eq 1 ]]; then
        random_delay "$file_param"
    fi

    handle_log_path

    local begin_time=$(format_time "$time_format" "$time")
    local begin_timestamp=$(format_timestamp "$time_format" "$time")
    
    eval echo -e "\#\# 开始执行... $begin_time\\\n" $cmd
    [[ -f $task_error_log_path ]] && eval cat $task_error_log_path $cmd

    [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"
    eval . $file_task_before "$@" $cmd

    cd $dir_scripts
    local relative_path="${file_param%/*}"
    if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
        cd ${relative_path}
        file_param=${file_param/$relative_path\//}
    fi
    
    eval $timeoutCmd $which_program $file_param $cmd

    eval . $file_task_after "$@" $cmd
    local end_time=$(date '+%Y-%m-%d %H:%M:%S')
    local end_timestamp=$(date "+%s")
    local diff_time=$(expr $end_timestamp - $begin_timestamp)
    [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
    eval echo -e "\\\n\#\# 执行结束... $end_time  耗时 $diff_time 秒" $cmd
}

## 并发执行时，设定的 RandomDelay 不会生效，即所有任务立即执行
run_concurrent() {
    local file_param="$1"
    local env_param="$2"
    local num_param=$(echo "$3" | perl -pe "s|.*$2(.*)|\1|")
    if [[ ! $env_param ]]; then
        echo -e "\n 缺少并发运行的环境变量参数"
        exit 1
    fi

    local envs=$(eval echo "\$${env_param}")
    local array=($(echo $envs | sed 's/&/ /g'))
    local tempArr=$(echo $num_param | perl -pe "s|(\d+)(-\|~\|_)(\d+)|{\1..\3}|g")
    local runArr=($(eval echo $tempArr))
    runArr=($(awk -v RS=' ' '!a[$1]++' <<< ${runArr[@]}))

    local n=0
    for i in ${runArr[@]}; do
        array_run[n]=${array[$i - 1]}
        let n++
    done

    local cookieStr=$(echo ${array_run[*]} | sed 's/\ /\&/g')
    [[ ! -z $cookieStr ]] && export ${env_param}=${cookieStr}

    handle_log_path

    local begin_time=$(format_time "$time_format" "$time")
    local begin_timestamp=$(format_timestamp "$time_format" "$time")

    eval echo -e "\#\# 开始执行... $begin_time\\\n" $cmd
    [[ -f $task_error_log_path ]] && eval cat $task_error_log_path $cmd

    [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"
    eval . $file_task_before "$@" $cmd

    local envs=$(eval echo "\$${env_param}")
    local array=($(echo $envs | sed 's/&/ /g'))
    single_log_time=$(date "+%Y-%m-%d-%H-%M-%S.%N")

    cd $dir_scripts
    local relative_path="${file_param%/*}"
    if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
        cd ${relative_path}
        file_param=${file_param/$relative_path\//}
    fi
    for i in "${!array[@]}"; do
        export ${env_param}=${array[i]}
        single_log_path="$dir_log/$log_dir/${single_log_time}_$((i + 1)).log"
        eval $timeoutCmd $which_program $file_param &>$single_log_path &
    done

    wait
    for i in "${!array[@]}"; do
        single_log_path="$dir_log/$log_dir/${single_log_time}_$((i + 1)).log"
        eval cat $single_log_path $cmd
        [[ -f $single_log_path ]] && rm -f $single_log_path
    done

    eval . $file_task_after "$@" $cmd
    local end_time=$(date '+%Y-%m-%d %H:%M:%S')
    local end_timestamp=$(date "+%s")
    local diff_time=$(( $end_timestamp - $begin_timestamp ))
    [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
    eval echo -e "\\\n\#\# 执行结束... $end_time  耗时 $diff_time 秒" $cmd
}

run_designated() {
    local file_param="$1"
    local env_param="$2"
    local num_param=$(echo "$3" | perl -pe "s|.*$2(.*)|\1|")
    if [[ ! $env_param ]] || [[ ! $num_param ]]; then
        echo -e "\n 缺少单独运行的参数 task xxx.js desi Test 1 3"
        exit 1
    fi

    handle_log_path

    local begin_time=$(format_time "$time_format" "$time")
    local begin_timestamp=$(format_timestamp "$time_format" "$time")

    local envs=$(eval echo "\$${env_param}")
    local array=($(echo $envs | sed 's/&/ /g'))
    local tempArr=$(echo $num_param | perl -pe "s|(\d+)(-\|~\|_)(\d+)|{\1..\3}|g")
    local runArr=($(eval echo $tempArr))
    runArr=($(awk -v RS=' ' '!a[$1]++' <<< ${runArr[@]}))

    local n=0
    for i in ${runArr[@]}; do
        array_run[n]=${array[$i - 1]}
        let n++
    done

    local cookieStr=$(echo ${array_run[*]} | sed 's/\ /\&/g')
    [[ ! -z $cookieStr ]] && export ${env_param}=${cookieStr}

    eval echo -e "\#\# 开始执行... $begin_time\\\n" $cmd
    [[ -f $task_error_log_path ]] && eval cat $task_error_log_path $cmd

    [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"
    eval . $file_task_before "$@" $cmd

    cd $dir_scripts
    local relative_path="${file_param%/*}"
    if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
        cd ${relative_path}
        file_param=${file_param/$relative_path\//}
    fi
    eval $timeoutCmd $which_program $file_param $cmd

    eval . $file_task_after "$@" $cmd
    local end_time=$(date '+%Y-%m-%d %H:%M:%S')
    local end_timestamp=$(date "+%s")
    local diff_time=$(( $end_timestamp - $begin_timestamp ))
    [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
    eval echo -e "\\\n\#\# 执行结束... $end_time  耗时 $diff_time 秒" $cmd
}

## 运行其他命令
run_else() {
    local file_param="$1"

    handle_log_path

    local begin_time=$(format_time "$time_format" "$time")
    local begin_timestamp=$(format_timestamp "$time_format" "$time")

    eval echo -e "\#\# 开始执行... $begin_time\\\n" $cmd
    [[ -f $task_error_log_path ]] && eval cat $task_error_log_path $cmd
    [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"
    eval . $file_task_before "$@" $cmd

    cd $dir_scripts
    local relative_path="${file_param%/*}"
    if [[ ! -z ${relative_path} ]] && [[ ${file_param} =~ "/" ]]; then
        cd ${relative_path}
        file_param=${file_param/$relative_path\//}
    fi

    shift
    eval $timeoutCmd $which_program "$file_param" "$@" $cmd

    eval . $file_task_after "$file_param" "$@" $cmd
    local end_time=$(date '+%Y-%m-%d %H:%M:%S')
    local end_timestamp=$(date "+%s")
    local diff_time=$(( $end_timestamp - $begin_timestamp ))
    [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
    eval echo -e "\\\n\#\# 执行结束... $end_time  耗时 $diff_time 秒" $cmd
}

## 命令检测
main() {
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

    timeoutCmd=""
    if type timeout &>/dev/null; then
        timeoutCmd="timeout -k 10s $command_timeout_time "
    fi

    time_format="%Y-%m-%d %H:%M:%S"
    if [[ $1 == *.js ]] || [[ $1 == *.py ]] || [[ $1 == *.pyc ]] || [[ $1 == *.sh ]] || [[ $1 == *.ts ]]; then
        case $# in
        1)
            run_normal "$1"
            ;;
        *)
            case $2 in
            now)
                run_normal "$1" "$2"
                ;;
            conc)
                run_concurrent "$1" "$3" "$*"
                ;;
            desi)
                run_designated "$1" "$3" "$*"
                ;;
            *)
                run_else "$@"
                ;;
            esac
            ;;
        esac
        [[ -f "$dir_log/$log_path" ]] && cat "$dir_log/$log_path"
    elif [[ $# -eq 0 ]]; then
        echo
        usage
    else
        run_else "$@"
    fi
}

main "$@"

exit 0
