#!/usr/bin/env bash

# 前置依赖 nodejs、npm、python3
set -e
set -x

if [[ ! $QL_DIR ]]; then
  npm_dir=$(npm root -g)
  pnpm_dir=$(pnpm root -g)
  if [[ -d "$npm_dir/@whyour/qinglong" ]]; then
    QL_DIR="$npm_dir/@whyour/qinglong"
  elif [[ -d "$pnpm_dir/@whyour/qinglong" ]]; then
    QL_DIR="$pnpm_dir/@whyour/qinglong"
  else
    t '未找到 qinglong 模块，请先执行 npm i -g @whyour/qinglong 安装'
  fi

  if [[ $QL_DIR ]]; then
    t '请先手动设置 export QL_DIR=%s，环境变量，并手动添加到系统环境变量，然后再次执行命令 qinglong 启动服务' "$QL_DIR"
  fi

  exit 1
fi

if [[ ! $QL_DATA_DIR ]]; then
  t '请先手动设置数据存储目录 export QL_DATA_DIR 环境变量，目录必须以斜杠开头的绝对路径，并且以 /data 结尾，例如 /ql/data 并手动添加到系统环境变量'
  exit 1
fi

if [[ $QL_DATA_DIR != */data ]]; then
  t 'QL_DATA_DIR 必须以 /data 结尾，例如 /ql/data，如果有历史数据，请新建 data 目录，把历史数据放到 data 目录中'
  exit 1
fi

command="$1"

if [[ $command != "reload" ]]; then
  # 安装依赖
  os_name="${QL_OS_TYPE:-}"
  if [ -z "$os_name" ]; then
    os_name=$(source /etc/os-release && echo "$ID")
  fi

  # 非 root 用户使用 sudo
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    SUDO="sudo"
  fi

  case "$os_name" in
    alpine)
      $SUDO apk update
      $SUDO apk add -f bash \
        coreutils \
        git \
        curl \
        wget \
        tzdata \
        perl \
        openssl \
        jq \
        nginx \
        openssh \
        procps \
        netcat-openbsd
      ;;
    debian|ubuntu)
      $SUDO apt-get update
      $SUDO apt-get install -y git curl wget tzdata perl openssl jq nginx procps netcat-openbsd openssh-client
      ;;
    *)
      t '暂不支持此系统部署 %s' "$os_name"
      exit 1
      ;;
  esac

  npm install -g pnpm@8.3.1 pm2 ts-node typescript@5
fi

export PYTHON_SHORT_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
export PNPM_HOME=${QL_DIR}/data/dep_cache/node
export PYTHON_HOME=${QL_DIR}/data/dep_cache/python3
export PYTHONUSERBASE=${QL_DIR}/data/dep_cache/python3

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PNPM_HOME}:${PYTHON_HOME}/bin
export NODE_PATH=/usr/local/bin:/usr/local/lib/node_modules:${PNPM_HOME}/global/5/node_modules
export PIP_CACHE_DIR=${PYTHON_HOME}/pip
export PYTHONPATH=${PYTHON_HOME}:${PYTHON_HOME}/lib/python${PYTHON_SHORT_VERSION}:${PYTHON_HOME}/lib/python${PYTHON_SHORT_VERSION}/site-packages

if [[ $command != "reload" ]]; then
  pip3 install --prefix ${PYTHON_HOME} requests
fi

cd ${QL_DIR}
cp -f .env.example .env
chmod 777 ${QL_DIR}/shell/*.sh

. ${QL_DIR}/shell/share.sh
. ${QL_DIR}/shell/env.sh

log_with_style() {
  local level="$1"
  local message="$2"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  printf "\n[%s] [%7s]  %s\n" "${timestamp}" "${level}" "${message}"
}

log_with_style "INFO" "🚀  1. 检测配置文件..."
import_config "$@"
make_dir /etc/nginx/conf.d
make_dir /run/nginx
fix_config

pm2 l &>/dev/null

log_with_style "INFO" "🔄  2. 启动 nginx..."
nginx -s reload 2>/dev/null || nginx -c /etc/nginx/nginx.conf

log_with_style "INFO" "⚙️  3. 启动 pm2 服务..."
reload_pm2

if [[ $command != "reload" ]]; then
  if [[ $AutoStartBot == true ]]; then
    log_with_style "INFO" "🤖 4. 启动 bot..."
    nohup ql bot >$dir_log/bot.log 2>&1 &
  fi

  if [[ $EnableExtraShell == true ]]; then
    log_with_style "INFO" "🛠️ 5. 执行自定义脚本..."
    nohup ql extra >$dir_log/extra.log 2>&1 &
  fi

  pm2 startup
  pm2 save
fi

log_with_style "SUCCESS" "🎉 启动成功!"
