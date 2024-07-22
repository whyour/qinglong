#!/usr/bin/env bash

## 目录
export dir_root=$QL_DIR
export dir_tmp=$dir_root/.tmp
export dir_data=$dir_root/data

if [[ $QL_DATA_DIR ]]; then
  export dir_data="${QL_DATA_DIR%/}"
fi

export dir_shell=$dir_root/shell
export dir_preload=$dir_shell/preload
export dir_sample=$dir_root/sample
export dir_static=$dir_root/static
export dir_config=$dir_data/config
export dir_scripts=$dir_data/scripts
export dir_repo=$dir_data/repo
export dir_raw=$dir_data/raw
export dir_log=$dir_data/log
export dir_db=$dir_data/db
export dir_dep=$dir_data/deps
export dir_list_tmp=$dir_log/.tmp
export dir_update_log=$dir_log/update
export ql_static_repo=$dir_repo/static

## 文件
export file_config_sample=$dir_sample/config.sample.sh
export file_env=$dir_preload/env.sh
export file_preload_js=$dir_preload/sitecustomize.js
export file_sharecode=$dir_config/sharecode.sh
export file_config_user=$dir_config/config.sh
export file_auth_sample=$dir_sample/auth.sample.json
export file_auth_user=$dir_config/auth.json
export file_auth_token=$dir_config/token.json
export file_extra_shell=$dir_config/extra.sh
export file_task_before=$dir_config/task_before.sh
export file_task_before_js=$dir_config/task_before.js
export file_task_before_py=$dir_config/task_before.py
export file_task_after=$dir_config/task_after.sh
export file_task_sample=$dir_sample/task.sample.sh
export file_extra_sample=$dir_sample/extra.sample.sh
export file_notify_js_sample=$dir_sample/notify.js
export file_notify_py_sample=$dir_sample/notify.py
export file_test_js_sample=$dir_sample/ql_sample.js
export file_test_py_sample=$dir_sample/ql_sample.py
export file_notify_py=$dir_scripts/notify.py
export file_notify_js=$dir_scripts/sendNotify.js
export file_test_js=$dir_scripts/ql_sample.js
export file_test_py=$dir_scripts/ql_sample.py
export nginx_app_conf=$dir_root/docker/front.conf
export nginx_conf=$dir_root/docker/nginx.conf
export dep_notify_py=$dir_dep/notify.py
export dep_notify_js=$dir_dep/sendNotify.js

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

  ql_base_url=${QlBaseUrl:-"/"}
  ql_port=${QlPort:-"5700"}
  command_timeout_time=${CommandTimeoutTime:-""}
  file_extensions=${RepoFileExtensions:-"js py"}
  proxy_url=${ProxyUrl:-""}
  current_branch=${QL_BRANCH}

  if [[ -n "${DefaultCronRule}" ]]; then
    default_cron="${DefaultCronRule}"
  else
    default_cron="$(random_range 0 59) $(random_range 0 23) * * *"
  fi
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

  if [[ ! -s $file_test_js ]]; then
    cp -fv $file_test_js_sample $file_test_js
    echo
  fi

  if [[ ! -s $file_test_py ]]; then
    cp -fv $file_test_py_sample $file_test_py
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

  git clone -q --depth=1 $part_cmd $url $dir
  exit_status=$?

  unset_proxy
}

random_range() {
  local beg=$1
  local end=$2
  echo $((RANDOM % ($end - $beg) + $beg))
}

delete_pm2() {
  cd $dir_root
  pm2 delete ecosystem.config.js
}

reload_pm2() {
  cd $dir_root
  restore_env_vars
  pm2 flush &>/dev/null
  pm2 startOrGracefulReload ecosystem.config.js
}

reload_update() {
  cd $dir_root
  restore_env_vars
  pm2 flush &>/dev/null
  pm2 startOrGracefulReload other.config.js
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

  if [[ -f "$dir_root/db/cookie.db" ]]; then
    echo -e "检测到旧的db文件，拷贝为新db...\n"
    mv $dir_root/db/cookie.db $dir_root/db/env.db
    rm -rf $dir_root/db/cookie.db
    echo
  fi

  if [[ -d "$dir_root/db" ]]; then
    echo -e "检测到旧的db目录，拷贝到data目录...\n"
    cp -rf $dir_root/config $dir_data
    echo
  fi

  if [[ -d "$dir_root/scripts" ]]; then
    echo -e "检测到旧的scripts目录，拷贝到data目录...\n"
    cp -rf $dir_root/scripts $dir_data
    echo
  fi

  if [[ -d "$dir_root/log" ]]; then
    echo -e "检测到旧的log目录，拷贝到data目录...\n"
    cp -rf $dir_root/log $dir_data
    echo
  fi

  if [[ -d "$dir_root/config" ]]; then
    echo -e "检测到旧的config目录，拷贝到data目录...\n"
    cp -rf $dir_root/config $dir_data
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
    if [[ $ql_base_url != /* ]]; then
      ql_base_url="/$ql_base_url"
    fi
    if [[ $ql_base_url != */ ]]; then
      ql_base_url="$ql_base_url/"
    fi
    location_url="^~${ql_base_url%*/}"
    aliasStr="alias ${dir_static}/dist;"
    if ! grep -q "<base href=\"$ql_base_url\">" "${dir_static}/dist/index.html"; then
      awk -v text="<base href=\"$ql_base_url\">" '/<link/ && !inserted {print text; inserted=1} 1' "${dir_static}/dist/index.html" >temp.html
      mv temp.html "${dir_static}/dist/index.html"
    fi
  else
    rootStr="root ${dir_static}/dist;"
  fi
  sed -i "s,QL_ALIAS_CONFIG,${aliasStr},g" /etc/nginx/conf.d/front.conf
  sed -i "s,QL_ROOT_CONFIG,${rootStr},g" /etc/nginx/conf.d/front.conf
  sed -i "s,QL_BASE_URL_LOCATION,${location_url},g" /etc/nginx/conf.d/front.conf
  sed -i "s,QL_BASE_URL,${ql_base_url},g" /etc/nginx/conf.d/front.conf

  local ipv6=$(ip a | grep inet6)
  local ipv6Str=""
  if [[ $ipv6 ]]; then
    ipv6Str="listen [::]:${ql_port} ipv6only=on;"
  fi

  local ipv4Str="listen ${ql_port};"
  sed -i "s,IPV6_CONFIG,${ipv6Str},g" /etc/nginx/conf.d/front.conf
  sed -i "s,IPV4_CONFIG,${ipv4Str},g" /etc/nginx/conf.d/front.conf
}

get_env_array() {
  exported_variables=()
  while IFS= read -r line; do
    exported_variables+=("$line")
  done < <(grep '^export ' $file_env | awk '{print $2}' | cut -d= -f1)
}

clear_env() {
  for var in "${exported_variables[@]}"; do
    unset "$var"
  done
}

handle_task_start() {
  [[ $ID ]] && update_cron "\"$ID\"" "0" "$$" "$log_path" "$begin_timestamp"
  echo -e "## 开始执行... $begin_time\n"
}

run_task_before() {
  . $file_task_before "$@"

  if [[ $task_before ]]; then
    echo -e "执行前置命令\n"
    eval "$task_before" "$@"
    echo -e "\n执行前置命令结束\n"
  fi
}

run_task_after() {
  . $file_task_after "$@"

  if [[ $task_after ]]; then
    echo -e "\n执行后置命令\n"
    eval "$task_after" "$@"
    echo -e "\n执行后置命令结束"
  fi
}

handle_task_end() {
  local etime=$(date "+$time_format")
  local end_time=$(format_time "$time_format" "$etime")
  local end_timestamp=$(format_timestamp "$time_format" "$etime")
  local diff_time=$(($end_timestamp - $begin_timestamp))

  [[ "$diff_time" == 0 ]] && diff_time=1

  echo -e "\n## 执行结束... $end_time  耗时 $diff_time 秒　　　　　"
  [[ $ID ]] && update_cron "\"$ID\"" "1" "" "$log_path" "$begin_timestamp" "$diff_time"
}

init_env
detect_termux
detect_macos
define_cmd
