#!/usr/bin/env bash

# 前置依赖 nodejs、npm、python3
set -e
set -x

# Configuration and language helpers are not loaded during bootstrap errors.
startup_message() {
  local format="$1"
  shift
  printf -- "$format\n" "$@" >&2
}

if [[ ! $QL_DIR ]]; then
  npm_dir=$(npm root -g 2>/dev/null) || npm_dir=""
  pnpm_dir=""
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_dir=$(pnpm root -g 2>/dev/null) || pnpm_dir=""
  fi
  if [[ -n "$npm_dir" && -d "$npm_dir/@whyour/qinglong" ]]; then
    QL_DIR="$npm_dir/@whyour/qinglong"
  elif [[ -n "$pnpm_dir" && -d "$pnpm_dir/@whyour/qinglong" ]]; then
    QL_DIR="$pnpm_dir/@whyour/qinglong"
  else
    startup_message '未找到 qinglong 模块，请先执行 npm i -g @whyour/qinglong 安装'
  fi

  if [[ $QL_DIR ]]; then
    startup_message '请先手动设置 export QL_DIR=%s，环境变量，并手动添加到系统环境变量，然后再次执行命令 qinglong 启动服务' "$QL_DIR"
  fi

  exit 1
fi

if [[ $QL_DIR != /* ]]; then
  startup_message 'QL_DIR 必须为绝对路径，例如 /ql'
  exit 1
fi

if [[ ! $QL_DATA_DIR ]]; then
  startup_message '请先手动设置数据存储目录 export QL_DATA_DIR 环境变量，目录必须以斜杠开头的绝对路径，并且以 /data 结尾，例如 /ql/data 并手动添加到系统环境变量'
  exit 1
fi

if [[ $QL_DATA_DIR != /*/data ]]; then
  startup_message 'QL_DATA_DIR 必须为以 /data 结尾的绝对路径，例如 /ql/data，如果有历史数据，请新建 data 目录，把历史数据放到 data 目录中'
  exit 1
fi

command="$1"

if [[ $command != "reload" ]]; then
  # 安装依赖
  os_name="${QL_OS_TYPE:-}"
  if [ -z "$os_name" ]; then
    if [[ -r /etc/os-release ]]; then
      os_name=$(source /etc/os-release && echo "$ID")
    else
      os_name=$(uname -s)
    fi
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
      startup_message '暂不支持此系统部署 %s' "$os_name"
      exit 1
      ;;
  esac

  npm install -g pnpm@8.3.1 pm2 ts-node typescript@5
fi

if [[ "$command" != "reload" ]]; then
  if [[ -n "${PYTHON_VENV_DIR:-}" ]]; then
    [[ "$PYTHON_VENV_DIR" = /* ]] || export PYTHON_VENV_DIR="${QL_DIR}/${PYTHON_VENV_DIR}"
    [[ -x "$PYTHON_VENV_DIR/bin/python3" ]] || python3 -m venv "$PYTHON_VENV_DIR"
    "$PYTHON_VENV_DIR/bin/python3" -m pip install requests
  else
    pip3 install --prefix "${PYTHON_HOME:-${QL_DATA_DIR}/dep_cache/python3}" requests
  fi
fi
exec /bin/bash "${QL_DIR}/shell/start-simplify.sh" "$@"
