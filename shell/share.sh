## 目录
dir_config=$dir_root/config
dir_scripts=$dir_root/scripts
dir_raw=$dir_scripts/raw
dir_log=$dir_root/log
dir_list_tmp=$dir_log/.tmp

## 文件
file_config_sample=$dir_sample/config.sample.sh
file_cookie=$dir_config/cookie.sh
file_sharecode=$dir_config/sharecode.sh
file_config_user=$dir_config/config.sh
file_auth_sample=$dir_sample/auth.sample.json
file_auth_user=$dir_config/auth.json
file_diy_shell=$dir_config/diy.sh

## 清单文件
list_crontab_user=$dir_config/crontab.list
list_crontab_sample=$dir_sample/crontab.sample.list
list_own_scripts=$dir_list_tmp/own_scripts.list
list_own_user=$dir_list_tmp/own_user.list
list_own_add=$dir_list_tmp/own_add.list
list_own_drop=$dir_list_tmp/own_drop.list

## 需组合的环境变量列表，env_name需要和var_name一一对应
env_name=(
    JD_COOKIE
)
var_name=(
    Cookie
)

## 软连接及其原始文件对应关系
link_name=(
    task
    mytask
    rmlog
    update
)
original_name=(
    task.sh
    task.sh
    rmlog.sh
    update.sh
)

## 导入配置文件不校验
import_config_no_check () {
    [ -f $file_cookie ] && . $file_cookie
    [ -f $file_sharecode ] && . $file_sharecode
    [ -f $file_config_user ] && . $file_config_user
}

## 导入配置文件并校验，$1：任务名称
import_config_and_check () {
    import_config_no_check $1
    if [[ -z ${Cookie1} ]]; then
        echo -e "请先在配置好Cookie...\n"
        exit 1
    fi
}

## 发送通知，依赖于import_config_and_check或import_config_no_check，$1：标题，$2：内容
notify () {
    local title=$(echo $1 | perl -pe 's|-|_|g')
    local msg="$(echo -e $2)"
    if [ -d $dir_scripts_node_modules ]; then
        node $dir_root/notify.js "$title" "$msg"
    fi
}

## 统计用户数量
count_user_sum () {
    for ((i=1; i<=${SUM:-$((3 * 4))}; i++)); do
        local tmp1=Cookie$i
        local tmp2=${!tmp1}
        [[ $tmp2 ]] && user_sum=$i || break
    done
}

## 创建目录，$1：目录的绝对路径
make_dir () {
    local dir=$1
    [ ! -d $dir ] && mkdir -p $dir
}

## 检测termux
detect_termux () {
    if [[ ${ANDROID_RUNTIME_ROOT}${ANDROID_ROOT} ]] || [[ $PATH == *com.termux* ]]; then
        is_termux=1
    else
        is_termux=0
    fi
}

## 检测macos
detect_macos () {
    [[ $(uname -s) == Darwin ]] && is_macos=1 || is_macos=0
}

## 生成随机数，$1：用来求余的数字
gen_random_num () {
    local divi=$1
    echo $((${RANDOM} % $divi))
}

## 创建软连接的子函数，$1：软连接文件路径，$2：要连接的对象
link_shell_sub () {
    local link_path="$1"
    local original_path="$2"
    if [ ! -L $link_path ] || [[ $(readlink -f $link_path) != $original_path ]]; then
        rm -f $link_path 2>/dev/null
        ln -sf $original_path $link_path
    fi
}

## 创建软连接
link_shell () {
    if [[ $is_termux -eq 1 ]]; then
        local path="/data/data/com.termux/files/usr/bin/"
    elif [[ $PATH == */usr/local/bin* ]] && [ -d /usr/local/bin ]; then
        local path="/usr/local/bin/"
    else
        local path=""
        echo -e "脚本功能受限，请自行添加命令的软连接...\n"
    fi
    if [[ $path ]]; then
        for ((i=0; i<${#link_name[*]}; i++)); do
            link_shell_sub "$path${link_name[i]}" "$dir_shell/${original_name[i]}"
        done
    fi
}

## 定义各命令
define_cmd () {
    local cmd_prefix cmd_suffix
    if type task >/dev/null 2>&1; then
        cmd_suffix=""
        if [ -x "$dir_shell/task.sh" ]; then
            cmd_prefix=""
        else
            cmd_prefix="bash "
        fi
    else
        cmd_suffix=".sh"
        if [ -x "$dir_shell/task.sh" ]; then
            cmd_prefix="$dir_shell/"
        else
            cmd_prefix="bash $dir_shell/"
        fi
    fi
    for ((i=0; i<${#link_name[*]}; i++)); do
        export cmd_${link_name[i]}="${cmd_prefix}${link_name[i]}${cmd_suffix}"
    done
}

## 修复配置文件
fix_config () {
    make_dir $dir_config
    if [ ! -s $file_config_user ]; then
        echo -e "复制一份 $file_config_sample 为 $file_config_user，随后请按注释编辑你的配置文件：$file_config_user\n"
        cp -fv $file_config_sample $file_config_user
        echo
    fi
    if [ ! -s $list_crontab_user ]; then
        echo -e "复制一份 $list_crontab_sample 为 $list_crontab_user，这是你自己的 crontab.list\n"
        cp -fv $list_crontab_sample $list_crontab_user
        echo
    fi
    perl -i -pe "{
        s|CMD_UPDATE|$cmd_jup|g;
        s|ROOT_DIR|$dir_root|g;
        s|CMD_RMLOG|$cmd_jlog|g;
        s|CMD_TASK|$cmd_task|g;
        s|CMD_MTASK|$cmd_mtask|g
    }" $list_crontab_user
}
