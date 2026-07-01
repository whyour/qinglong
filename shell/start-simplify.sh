#!/usr/bin/env bash

# 简化版启动脚本：跳过系统依赖和 npm 全局安装
# 前置要求：已安装 nodejs、npm/pnpm、python3、nginx、jq
set -e
set -x

if [[ ! $QL_DIR ]]; then
  echo -e "请先设置 export QL_DIR=<qinglong目录>"
  exit 1
fi

if [[ ! $QL_DATA_DIR ]]; then
  export QL_DATA_DIR="${QL_DIR}/data"
fi

if [[ $QL_DATA_DIR != */data ]]; then
  echo -e "QL_DATA_DIR 必须以 /data 结尾，例如 /ql/data"
  exit 1
fi

command="$1"

# 从 .env 文件读取 PYTHON_VENV_DIR
if [[ -z "${PYTHON_VENV_DIR:-}" ]] && [[ -f "${QL_DIR}/.env" ]]; then
  env_venv_dir=$(grep -E '^PYTHON_VENV_DIR=' "${QL_DIR}/.env" | tail -1 | cut -d'=' -f2 | xargs)
  if [[ -n "$env_venv_dir" ]]; then
    if [[ "$env_venv_dir" != /* ]]; then
      env_venv_dir="${QL_DIR}/${env_venv_dir}"
    fi
    export PYTHON_VENV_DIR="$env_venv_dir"
  fi
fi

export PNPM_HOME=${QL_DIR}/data/dep_cache/node

# ===== Python venv =====
export PYTHON_VENV_DIR="${PYTHON_VENV_DIR:-${QL_DIR}/.venv}"
if [[ ! -f "${PYTHON_VENV_DIR}/bin/python3" ]]; then
  echo "正在创建 Python venv: ${PYTHON_VENV_DIR}"
  python3 -m venv "${PYTHON_VENV_DIR}"
fi

export PATH=${PYTHON_VENV_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PNPM_HOME}
export NODE_PATH=/usr/local/bin:/usr/local/lib/node_modules:${PNPM_HOME}/global/5/node_modules
export PIP_CACHE_DIR=${PYTHON_VENV_DIR}/pip
mkdir -p "${PIP_CACHE_DIR}"

if [[ $command != "reload" ]]; then
  ${PYTHON_VENV_DIR}/bin/pip3 install requests
fi

cd ${QL_DIR}
# 仅在 .env 不存在时从 .env.example 复制
if [[ ! -f .env ]] && [[ -f .env.example ]]; then
  cp -f .env.example .env
fi
chmod 777 ${QL_DIR}/shell/*.sh

# 确保 task/ql 命令指向当前部署目录（覆盖 npm 全局安装可能指向旧路径的软链接）
ln -sf ${QL_DIR}/shell/task.sh /usr/local/bin/task 2>/dev/null || true
ln -sf ${QL_DIR}/shell/update.sh /usr/local/bin/ql 2>/dev/null || true

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
