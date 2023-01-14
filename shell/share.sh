#!/usr/bin/env bash

## 目录
dir_root=$QL_DIR
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
task_error_log_path=$dir_log/task_error.log
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

  ql_base_url=${QlBaseUrl:-""}
  command_timeout_time=${CommandTimeoutTime:-"1h"}
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
}

npm_install_1() {
  local dir_current=$(pwd)
  local dir_work=$1

  cd $dir_work
  echo -e "运行 npm install...\n"
  npm_install_sub
  [[ $? -ne 0 ]] && echo -e "\nnpm install 运行不成功，请进入 $dir_work 目录后手动运行 npm install...\n"
  cd $dir_current
}

npm_install_2() {
  local dir_current=$(pwd)
  local dir_work=$1

  cd $dir_work
  echo -e "检测到 $dir_work 的依赖包有变化，运行 npm install...\n"
  npm_install_sub
  if [[ $? -ne 0 ]]; then
    echo -e "\n安装 $dir_work 的依赖包运行不成功，再次尝试一遍...\n"
    npm_install_1 $dir_work
  fi
  cd $dir_current
}

diff_and_copy() {
  local copy_source=$1
  local copy_to=$2
  if [[ ! -s $copy_to ]] || [[ $(diff $copy_source $copy_to) ]]; then
    cp -f $copy_source $copy_to
  fi
}

update_depend() {
  local dir_current=$(pwd)

  if [[ ! -s $dir_scripts/package.json ]] || [[ $(diff $dir_sample/package.json $dir_scripts/package.json) ]]; then
    cp -f $dir_sample/package.json $dir_scripts/package.json
    npm_install_2 $dir_scripts
  fi

  cd $dir_current
}

git_clone_scripts() {
  local url="$1"
  local dir="$2"
  local branch="$3"
  local proxy="$4"
  [[ $branch ]] && local part_cmd="-b $branch "
  echo -e "开始克隆仓库 $url 到 $dir\n"

  set_proxy "$proxy"
  git clone $part_cmd $url $dir
  exit_status=$?
  unset_proxy
}

git_pull_scripts() {
  local dir_current=$(pwd)
  local dir_work="$1"
  local branch="$2"
  local proxy="$3"
  cd $dir_work
  echo -e "开始更新仓库：$dir_work\n"

  set_proxy "$proxy"
  git fetch --all
  exit_status=$?
  git pull &>/dev/null
  unset_proxy

  cd $dir_current
}

reset_romote_url() {
  local dir_current=$(pwd)
  local dir_work=$1
  local url=$2
  local branch="$3"

  cd $dir_work
  if [[ -d "$dir_work/.git" ]]; then
    [[ -f ".git/index.lock" ]] && rm -f .git/index.lock >/dev/null
    git remote set-url origin $url &>/dev/null
  else
    git init
    git remote add origin $url &>/dev/null
  fi
  reset_branch "$branch"
  cd $dir_current
}

reset_branch() {
  local branch="$1"
  local part_cmd=""
  if [[ $branch ]]; then
    part_cmd="origin/${branch}"
    git checkout -B "$branch" &>/dev/null
    git branch --set-upstream-to=$part_cmd $branch &>/dev/null
  fi
  git reset --hard $part_cmd &>/dev/null
}

random_range() {
  local beg=$1
  local end=$2
  echo $((RANDOM % ($end - $beg) + $beg))
}

reload_pm2() {
  pm2 l &>/dev/null

  echo -e "启动面板服务\n"
  pm2 delete panel --source-map-support --time &>/dev/null
  pm2 start $dir_static/build/app.js -n panel --source-map-support --time &>/dev/null

  echo -e "启动定时任务服务\n"
  pm2 delete schedule --source-map-support --time &>/dev/null
  pm2 start $dir_static/build/schedule.js -n schedule --source-map-support --time &>/dev/null
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
    echo $(date -j -f "$format" "$time" "+%Y-%m-%d-%H-%M-%S")
  else
    echo $(date -d "$time" "+%Y-%m-%d-%H-%M-%S")
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
  if [[ $PipMirror ]]; then
    pip3 config set global.index-url $PipMirror
  fi
  if [[ $NpmMirror ]]; then
    npm config set registry $NpmMirror
  fi

  # 兼容pnpm@7
  pnpm setup &>/dev/null
  source ~/.bashrc
  pnpm install -g &>/dev/null

  if [[ -f "$dir_root/db/cookie.db" ]]; then
    echo -e "检测到旧的db文件，拷贝为新db...\n"
    mv $dir_root/db/cookie.db $dir_root/db/env.db
    rm -rf $dir_root/db/cookie.db
    echo
  fi

  if ! type ts-node &>/dev/null; then
    pnpm add -g ts-node typescript tslib
  fi

  git config --global pull.rebase false

  cp -f $dir_root/.env.example $dir_root/.env

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

init_env
detect_termux
detect_macos
define_cmd
fix_config

import_config $1 2>$task_error_log_path
