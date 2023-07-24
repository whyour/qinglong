#!/usr/bin/env bash

## 目录
dir_root=$QL_DIR
dir_tmp=$dir_root/.tmp
dir_data=$dir_root/data
dir_shell=$dir_root/shell
dir_sample=$dir_root/sample
dir_static=$dir_root/static
dir_config=$dir_data/config
dir_scripts=$dir_data/scripts
dir_repo=$dir_data/repo
dir_raw=$dir_data/raw
dir_log=$dir_data/log
dir_db=$dir_data/db
dir_dep=$dir_data/deps
dir_list_tmp=$dir_log/.tmp
dir_update_log=$dir_log/update
ql_static_repo=$dir_repo/static

## 文件
file_ecosystem_js=$dir_root/ecosystem.config.js
file_config_sample=$dir_sample/config.sample.sh
file_env=$dir_config/env.sh
file_sharecode=$dir_config/sharecode.sh
file_config_user=$dir_config/config.sh
file_auth_sample=$dir_sample/auth.sample.json
file_auth_user=$dir_config/auth.json
file_auth_token=$dir_config/token.json
file_extra_shell=$dir_config/extra.sh
file_task_before=$dir_config/task_before.sh
file_task_after=$dir_config/task_after.sh
file_task_sample=$dir_sample/task.sample.sh
file_extra_sample=$dir_sample/extra.sample.sh
file_notify_js_sample=$dir_sample/notify.js
file_notify_py_sample=$dir_sample/notify.py
file_notify_py=$dir_scripts/notify.py
file_notify_js=$dir_scripts/sendNotify.js
nginx_app_conf=$dir_root/docker/front.conf
nginx_conf=$dir_root/docker/nginx.conf
dep_notify_py=$dir_dep/notify.py
dep_notify_js=$dir_dep/sendNotify.js

## 清单文件
list_crontab_user=$dir_config/crontab.list
list_crontab_sample=$dir_sample/crontab.sample.list
list_own_scripts=$dir_list_tmp/own_scripts.list
list_own_user=$dir_list_tmp/own_user.list
list_own_add=$dir_list_tmp/own_add.list
list_own_drop=$dir_list_tmp/own_drop.list

## 软连接及其原始文件对应关系
link_name=(
  task
  ql
)
original_name=(
  task.sh
  update.sh
)

init_env() {
  export NODE_PATH=/usr/local/bin:/usr/local/pnpm-global/5/node_modules:/usr/local/lib/node_modules:/root/.local/share/pnpm/global/5/node_modules
  export PYTHONUNBUFFERED=1
}

import_config() {
  [[ -f $file_config_user ]] && . $file_config_user
  [[ -f $file_env ]] && . $file_env

  ql_base_url=${QlBaseUrl:-"/"}
  command_timeout_time=${CommandTimeoutTime:-""}
  proxy_url=${ProxyUrl:-""}
  file_extensions=${RepoFileExtensions:-"js py"}
  current_branch=${QL_BRANCH}

  if [[ -n "${DefaultCronRule}" ]]; then
    default_cron="${DefaultCronRule}"
  else
    default_cron="$(random_range 0 59) $(random_range 0 23) * * *"
  fi

  cpu_warn=${CpuWarn}
  mem_warn=${MemoryWarn}
  disk_warn=${DiskWarn}
}

set_proxy() {
  local proxy="$1"
  if [[ $proxy ]]; then
    proxy_url="$proxy"
  fi
  if [[ $proxy_url ]]; then
    export http_proxy="${proxy_url}"
    export https_proxy="${proxy_url}"
  fi
}

unset_proxy() {
  unset http_proxy
  unset https_proxy
  unset ftp_proxy
  unset all_proxy
  unset no_proxy
}

make_dir() {
  local dir=$1
  if [[ ! -d $dir ]]; then
    mkdir -p $dir
  fi
}

detect_termux() {
  if [[ $PATH == *com.termux* ]]; then
    is_termux=1
  else
    is_termux=0
  fi
}

detect_macos() {
  [[ $(uname -s) == Darwin ]] && is_macos=1 || is_macos=0
}

gen_random_num() {
  local divi=$1
  echo $((${RANDOM} % $divi))
}

link_shell_sub() {
  local link_path="$1"
  local original_path="$2"
  if [[ ! -L $link_path ]] || [[ $(readlink -f $link_path) != $original_path ]]; then
    rm -f $link_path 2>/dev/null
    ln -sf $original_path $link_path
  fi
}

link_shell() {
  if [[ $is_termux -eq 1 ]]; then
    local path="/data/data/com.termux/files/usr/bin/"
  elif [[ $PATH == */usr/local/bin* ]] && [[ -d /usr/local/bin ]]; then
    local path="/usr/local/bin/"
  else
    local path=""
    echo -e "脚本功能受限，请自行添加命令的软连接...\n"
  fi
  if [[ $path ]]; then
    for ((i = 0; i < ${#link_name[*]}; i++)); do
      link_shell_sub "$path${link_name[i]}" "$dir_shell/${original_name[i]}"
    done
  fi
}

define_cmd() {
  local cmd_prefix cmd_suffix
  if type task &>/dev/null; then
    cmd_suffix=""
    if [[ -f "$dir_shell/task.sh" ]]; then
      cmd_prefix=""
    else
      cmd_prefix="bash "
    fi
  else
    cmd_suffix=".sh"
    if [[ -f "$dir_shell/task.sh" ]]; then
      cmd_prefix="$dir_shell/"
    else
      cmd_prefix="bash $dir_shell/"
    fi
  fi
  for ((i = 0; i < ${#link_name[*]}; i++)); do
    export cmd_${link_name[i]}="${cmd_prefix}${link_name[i]}${cmd_suffix}"
  done
}

fix_config() {
  make_dir $dir_tmp
  make_dir $dir_static
  make_dir $dir_data
  make_dir $dir_config
  make_dir $dir_log
  make_dir $dir_db
  make_dir $dir_scripts
  make_dir $dir_list_tmp
  make_dir $dir_repo
  make_dir $dir_raw
  make_dir $dir_update_log
  make_dir $dir_dep

  if [[ ! -s $file_config_user ]]; then
    echo -e "复制一份 $file_config_sample 为 $file_config_user，随后请按注释编辑你的配置文件：$file_config_user\n"
    cp -fv $file_config_sample $file_config_user
    echo
  fi

  if [[ ! -f $file_env ]]; then
    echo -e "检测到config配置目录下不存在env.sh，创建一个空文件用于初始化...\n"
    touch $file_env
    echo
  fi

  if [[ ! -f $file_task_before ]]; then
    echo -e "复制一份 $file_task_sample 为 $file_task_before\n"
    cp -fv $file_task_sample $file_task_before
    echo
  fi

  if [[ ! -f $file_task_after ]]; then
    echo -e "复制一份 $file_task_sample 为 $file_task_after\n"
    cp -fv $file_task_sample $file_task_after
    echo
  fi

  if [[ ! -f $file_extra_shell ]]; then
    echo -e "复制一份 $file_extra_sample 为 $file_extra_shell\n"
    cp -fv $file_extra_sample $file_extra_shell
    echo
  fi

  if [[ ! -s $file_auth_user ]]; then
    echo -e "复制一份 $file_auth_sample 为 $file_auth_user\n"
    cp -fv $file_auth_sample $file_auth_user
    echo
  fi

  if [[ ! -s $file_notify_py ]]; then
    echo -e "复制一份 $file_notify_py_sample 为 $file_notify_py\n"
    cp -fv $file_notify_py_sample $file_notify_py
    echo
  fi

  if [[ ! -s $file_notify_js ]]; then
    echo -e "复制一份 $file_notify_js_sample 为 $file_notify_js\n"
    cp -fv $file_notify_js_sample $file_notify_js
    echo
  fi

  if [[ -s /etc/nginx/conf.d/default.conf ]]; then
    echo -e "检测到默认nginx配置文件，清空...\n"
    cat /dev/null >/etc/nginx/conf.d/default.conf
    echo
  fi

  if [[ ! -s $dep_notify_js ]]; then
    echo -e "复制一份 $file_notify_js_sample 为 $dep_notify_js\n"
    cp -fv $file_notify_js_sample $dep_notify_js
    echo
  fi

  if [[ ! -s $dep_notify_py ]]; then
    echo -e "复制一份 $file_notify_py_sample 为 $dep_notify_py\n"
    cp -fv $file_notify_py_sample $dep_notify_py
    echo
  fi

}

npm_install_sub() {
  if [ $is_termux -eq 1 ]; then
    npm install --production --no-bin-links
  elif ! type pnpm &>/dev/null; then
    npm install --production
  else
    pnpm install --loglevel error --production
  fi
  exit_status=$?
}

npm_install_2() {
  local dir_current=$(pwd)
  local dir_work=$1

  cd $dir_work
  echo -e "安装 $dir_work 依赖包...\n"
  npm_install_sub
  cd $dir_current
}

diff_and_copy() {
  local copy_source=$1
  local copy_to=$2
  if [[ ! -s $copy_to ]] || [[ $(diff $copy_source $copy_to) ]]; then
    cp -f $copy_source $copy_to
  fi
}

git_clone_scripts() {
  local url="$1"
  local dir="$2"
  local branch="$3"
  local proxy="$4"
  [[ $branch ]] && local part_cmd="-b $branch "
  echo -e "开始拉取仓库 ${uniq_path} 到 $dir\n"

  set_proxy "$proxy"

  git clone --depth=1 $part_cmd $url $dir
  exit_status=$?

  unset_proxy
}

random_range() {
  local beg=$1
  local end=$2
  echo $((RANDOM % ($end - $beg) + $beg))
}

reload_pm2() {
  cd $dir_root
  # 代理会影响 grpc 服务
  unset_proxy
  pm2 flush &>/dev/null
  pm2 startOrGracefulReload $file_ecosystem_js --update-env
}

diff_time() {
  local format="$1"
  local begin_time="$2"
  local end_time="$3"

  if [[ $is_macos -eq 1 ]]; then
    diff_time=$(($(date -j -f "$format" "$end_time" +%s) - $(date -j -f "$format" "$begin_time" +%s)))
  else
    diff_time=$(($(date +%s -d "$end_time") - $(date +%s -d "$begin_time")))
  fi
  echo "$diff_time"
}

format_time() {
  local format="$1"
  local time="$2"

  if [[ $is_macos -eq 1 ]]; then
    echo $(date -j -f "$format" "$time" "+%Y-%m-%d %H:%M:%S")
  else
    echo $(date -d "$time" "+%Y-%m-%d %H:%M:%S")
  fi
}

format_log_time() {
  local format="$1"
  local time="$2"

  if [[ $is_macos -eq 1 ]]; then
    echo $(date -j -f "$format" "$time" "+%Y-%m-%d-%H-%M-%S-%3N")
  else
    echo $(date -d "$time" "+%Y-%m-%d-%H-%M-%S-%3N")
  fi
}

format_timestamp() {
  local format="$1"
  local time="$2"

  if [[ $is_macos -eq 1 ]]; then
    echo $(date -j -f "$format" "$time" "+%s")
  else
    echo $(date -d "$time" "+%s")
  fi
}

patch_version() {
  git config --global pull.rebase false

  cp -f $dir_root/.env.example $dir_root/.env

  if [[ -f "$dir_root/db/cookie.db" ]]; then
    echo -e "检测到旧的db文件，拷贝为新db...\n"
    mv $dir_root/db/cookie.db $dir_root/db/env.db
    rm -rf $dir_root/db/cookie.db
    echo
  fi

  if [[ -d "$dir_root/db" ]]; then
    echo -e "检测到旧的db目录，拷贝到data目录...\n"
    cp -rf $dir_root/config $dir_root/data
    echo
  fi

  if [[ -d "$dir_root/scripts" ]]; then
    echo -e "检测到旧的scripts目录，拷贝到data目录...\n"
    cp -rf $dir_root/scripts $dir_root/data
    echo
  fi

  if [[ -d "$dir_root/log" ]]; then
    echo -e "检测到旧的log目录，拷贝到data目录...\n"
    cp -rf $dir_root/log $dir_root/data
    echo
  fi

  if [[ -d "$dir_root/config" ]]; then
    echo -e "检测到旧的config目录，拷贝到data目录...\n"
    cp -rf $dir_root/config $dir_root/data
    echo
  fi
}

init_nginx() {
  cp -fv $nginx_conf /etc/nginx/nginx.conf
  cp -fv $nginx_app_conf /etc/nginx/conf.d/front.conf
  local location_url="/"
  local aliasStr=""
  local rootStr=""
  if [[ $ql_base_url != "/" ]]; then
    location_url="^~${ql_base_url%*/}"
    aliasStr="alias ${dir_static}/dist;"
  else
    rootStr="root ${dir_static}/dist;"
  fi
  sed -i "s,QL_ALIAS_CONFIG,${aliasStr},g" /etc/nginx/conf.d/front.conf
  sed -i "s,QL_ROOT_CONFIG,${rootStr},g" /etc/nginx/conf.d/front.conf
  sed -i "s,QL_BASE_URL_LOCATION,${location_url},g" /etc/nginx/conf.d/front.conf
  sed -i "s,QL_BASE_URL,${ql_base_url},g" /etc/nginx/conf.d/front.conf

  ipv6=$(ip a | grep inet6)
  ipv6Str=""
  if [[ $ipv6 ]]; then
    ipv6Str="listen [::]:5700 ipv6only=on;"
  fi
  sed -i "s,IPV6_CONFIG,${ipv6Str},g" /etc/nginx/conf.d/front.conf
}

handle_task_before() {
  [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"

  echo -e "## 开始执行... $begin_time\n"

  [[ $is_macos -eq 0 ]] && check_server

  . $file_task_before "$@"
}

handle_task_after() {
  . $file_task_after "$@"

  local etime=$(date "+$time_format")
  local end_time=$(format_time "$time_format" "$etime")
  local end_timestamp=$(format_timestamp "$time_format" "$etime")
  local diff_time=$(($end_timestamp - $begin_timestamp))

  [[ "$diff_time" == 0 ]] && diff_time=1

  echo -e "\n\n## 执行结束... $end_time  耗时 $diff_time 秒　　　　　"

  [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
}

init_env
detect_termux
detect_macos
define_cmd

import_config $1
