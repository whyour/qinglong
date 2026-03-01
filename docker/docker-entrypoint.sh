#!/bin/bash

dir_shell=/ql/shell
. $dir_shell/share.sh

export_ql_envs() {
  export BACK_PORT="${ql_port}"
  export GRPC_PORT="${ql_grpc_port}"
}

log_with_style() {
  local level="$1"
  local message="$2"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  printf "\n[%s] [%7s]  %s\n" "${timestamp}" "${level}" "${message}"
}

# Fix DNS resolution issues in Alpine Linux
# Alpine uses musl libc which has known DNS resolver issues with certain domains
# Adding ndots:0 prevents unnecessary search domain appending
if [ -f /etc/alpine-release ]; then
  if ! grep -q "^options ndots:0" /etc/resolv.conf 2>/dev/null; then
    echo "options ndots:0" >> /etc/resolv.conf
    log_with_style "INFO" "🔧  0. 已配置 DNS 解析优化 (ndots:0)"
  fi
fi

log_with_style "INFO" "🚀  1. 检测配置文件..."
load_ql_envs
export_ql_envs
. $dir_shell/env.sh
import_config "$@"
fix_config

# Try to initialize PM2, but don't fail if it doesn't work
pm2 l &>/dev/null || log_with_style "WARN" "PM2 初始化可能失败，将在启动时尝试使用备用方案"

log_with_style "INFO" "⚙️  2. 启动 pm2 服务..."
reload_pm2

if [[ $AutoStartBot == true ]]; then
  log_with_style "INFO" "🤖  3. 启动 bot..."
  nohup ql bot >$dir_log/bot.log 2>&1 &
fi

if [[ $EnableExtraShell == true ]]; then
  log_with_style "INFO" "🛠️  4. 执行自定义脚本..."
  nohup ql extra >$dir_log/extra.log 2>&1 &
fi

log_with_style "SUCCESS" "🎉  容器启动成功!"

crond -f >/dev/null

exec "$@"
