## 目录
dir_sample=$dir_root/sample
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
file_extra_shell=$dir_config/extra.sh

## 清单文件
list_crontab_user=$dir_config/crontab.list
list_crontab_sample=$dir_sample/crontab.sample.list
list_own_scripts=$dir_list_tmp/own_scripts.list
list_own_user=$dir_list_tmp/own_user.list
list_own_add=$dir_list_tmp/own_add.list
list_own_drop=$dir_list_tmp/own_drop.list

## 需组合的环境变量列表，env_name需要和var_name一一对应，需要从api取信息
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
    rebuild
)
original_name=(
    task.sh
    task.sh
    rmlog.sh
    update.sh
    rebuild.sh
)

## 导入配置文件不校验
import_config_no_check () {
    [ -f $file_cookie ] && . $file_cookie
    [ -f $file_config_user ] && . $file_config_user
}

## 导入配置文件并校验，$1：任务名称
import_config_and_check () {
    import_config_no_check $1
    if [[ ! -s $file_cookie ]]; then
        echo -e "请先配置好Cookie...\n"
        exit 1
    else
        user_sum=0
        for line in $(cat $file_cookie); do
            let user_sum++
            [[ $user_sum -gt $((3 * 5)) ]] && break
            eval Cookie${user_sum}="\"$line\""
        done
    fi
}

## 发送通知，依赖于import_config_and_check或import_config_no_check，$1：标题，$2：内容
notify () {
    local title=$(echo $1 | perl -pe 's|-|_|g')
    local msg="$(echo -e $2)"
    if [ -d $dir_scripts_node_modules ]; then
        node $dir_shell/notify.js "$title" "$msg"
    fi
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

## 统计 own 仓库数量
count_own_repo_sum () {
    own_repo_sum=0
    for ((i=1; i<=1000; i++)); do
        local tmp1=RepoUrl$i
        local tmp2=${!tmp1}
        [[ $tmp2 ]] && own_repo_sum=$i || break
    done
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
            array_own_repo_dir[$repo_num]=$(echo ${array_own_repo_url[$repo_num]} | perl -pe "s|\.git||" | awk -F "/|:" '{print $((NF - 1)) "_" $NF}')
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
        s|CMD_UPDATE|$cmd_update|g;
        s|CMD_REBUILD|$cmd_rebuild|g;
        s|CMD_RMLOG|$cmd_rmlog|g;
        s|CMD_TASK|$cmd_task|g;
        s|CMD_MYTASK|$cmd_mytask|g
    }" $list_crontab_user
}
