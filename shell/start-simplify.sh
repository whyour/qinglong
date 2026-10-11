#!/usr/bin/env bash
set -e

: "${QL_DIR:?Please set QL_DIR}"
: "${QL_DATA_DIR:?Please set QL_DATA_DIR}"
[[ "$QL_DIR" = /* && "$QL_DATA_DIR" = /*/data ]] || { echo "QL_DIR and QL_DATA_DIR must be absolute paths (data directory ends in /data)" >&2; exit 1; }
command="$1"

export PNPM_HOME="${PNPM_HOME:-${QL_DATA_DIR}/dep_cache/node}"
if [[ -n "${PYTHON_VENV_DIR:-}" ]]; then
  [[ "$PYTHON_VENV_DIR" = /* ]] || PYTHON_VENV_DIR="${QL_DIR}/${PYTHON_VENV_DIR}"
  export PYTHON_VENV_DIR
  if [[ ! -x "$PYTHON_VENV_DIR/bin/python3" ]]; then
    python3 -m venv "$PYTHON_VENV_DIR"
  fi
  [[ -x "$PYTHON_VENV_DIR/bin/python3" ]] || { echo "Invalid Python venv" >&2; exit 1; }
  unset PYTHON_HOME PYTHONUSERBASE PYTHONPATH
  export PATH="${PYTHON_VENV_DIR}/bin:${PATH}:${PNPM_HOME}"
  export PIP_CACHE_DIR="${PYTHON_VENV_DIR}/pip"
else
  export PYTHON_SHORT_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  export PYTHON_HOME="${PYTHON_HOME:-${QL_DATA_DIR}/dep_cache/python3}"
  export PYTHONUSERBASE="$PYTHON_HOME"
  export PATH="${PATH}:${PNPM_HOME}:${PYTHON_HOME}/bin"
  export PIP_CACHE_DIR="${PYTHON_HOME}/pip"
  export PYTHONPATH="${PYTHON_HOME}:${PYTHON_HOME}/lib/python${PYTHON_SHORT_VERSION}:${PYTHON_HOME}/lib/python${PYTHON_SHORT_VERSION}/site-packages"
fi
export NODE_PATH="${NODE_PATH:-/usr/local/bin:/usr/local/lib/node_modules:${PNPM_HOME}/global/5/node_modules}"
mkdir -p "$PIP_CACHE_DIR"

cd "${QL_DIR}"
if [[ ! -e .env ]]; then
  # Preserve user configuration, including a file created concurrently.
  (umask 077; set -C; cat .env.example > .env)
fi
chmod u+x "${QL_DIR}"/shell/*.sh

. "${QL_DIR}/shell/share.sh"
. "${QL_DIR}/shell/env.sh"

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
