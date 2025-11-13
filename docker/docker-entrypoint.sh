#!/bin/bash

dir_shell=/ql/shell
. $dir_shell/share.sh
. $dir_shell/env.sh

log_with_style() {
  local level="$1"
  local message="$2"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  printf "\n[%s] [%7s]  %s\n" "${timestamp}" "${level}" "${message}"
}

log_with_style "INFO" "🚀 1. 检测配置文件..."
import_config "$@"
# Export BACK_PORT from QlPort for backend server to use
export BACK_PORT="${ql_port}"
fix_config

pm2 l &>/dev/null

log_with_style "INFO" "⚙️  2. 启动 pm2 服务..."
reload_pm2

if [[ $AutoStartBot == true ]]; then
  log_with_style "INFO" "🤖 3. 启动 bot..."
  nohup ql bot >$dir_log/bot.log 2>&1 &
fi

if [[ $EnableExtraShell == true ]]; then
  log_with_style "INFO" "🛠️ 4. 执行自定义脚本..."
  nohup ql extra >$dir_log/extra.log 2>&1 &
fi

log_with_style "SUCCESS" "🎉 容器启动成功!"

crond -f >/dev/null

exec "$@"
