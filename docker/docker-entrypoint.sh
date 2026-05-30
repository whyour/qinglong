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

# ============================================
# 确保当前用户对 /ql 和 /ql/data 目录有写入权限
# /ql/data 是 Docker Volume 挂载点，权限可能与 /ql 不同，需单独检测
# ============================================
ensure_ql_permissions() {
  local current_uid
  local current_gid
  current_uid=$(id -u)
  current_gid=$(id -g)

  if [ "$current_uid" -eq 0 ]; then
    return 0
  fi

  # ---- 检查 /ql 目录 ----
  if ! mkdir -p "$QL_DIR/.tmp" 2>/dev/null; then
    if chown -R "$current_uid:$current_gid" "$QL_DIR" 2>/dev/null; then
      log_with_style "INFO" "已修正 /ql 目录权限: UID=$current_uid GID=$current_gid"
    else
      local ql_owner
      ql_owner=$(stat -c '%u' "$QL_DIR" 2>/dev/null || stat -f '%u' "$QL_DIR" 2>/dev/null)
      log_with_style "ERROR" "============================================="
      log_with_style "ERROR" "  权限错误：无法写入 /ql 目录"
      log_with_style "ERROR" "  当前用户 UID: $current_uid"
      log_with_style "ERROR" "  /ql 目录所有者 UID: ${ql_owner:-未知}"
      log_with_style "ERROR" ""
      log_with_style "ERROR" "  解决方案："
      log_with_style "ERROR" "  1. 使用镜像内置用户: docker run --user ${ql_owner:-5432}:${ql_owner:-5432} ..."
      log_with_style "ERROR" "  2. 使用 root 运行: 移除 --user 参数"
      log_with_style "ERROR" "  3. 修正宿主机数据目录: chown -R $current_uid:$current_gid /path/to/ql/data"
      log_with_style "ERROR" "============================================="
      exit 1
    fi
  fi
  rmdir "$QL_DIR/.tmp" 2>/dev/null || true

  # ---- 检查 /ql/data 目录（Volume 挂载点，不在用户数据卷内创建临时文件） ----
  if [ ! -w "$QL_DIR/data" ] || [ ! -x "$QL_DIR/data" ]; then
    if chown "$current_uid:$current_gid" "$QL_DIR/data" 2>/dev/null; then
      log_with_style "INFO" "已修正 /ql/data 目录权限: UID=$current_uid GID=$current_gid"
      if [ ! -w "$QL_DIR/data" ] || [ ! -x "$QL_DIR/data" ]; then
        log_with_style "ERROR" "修正后仍无法写入 /ql/data，请检查挂载的数据卷权限"
        log_with_style "ERROR" "确保宿主机目录: chown -R $current_uid:$current_gid /your/data"
        exit 1
      fi
    else
      local data_owner
      data_owner=$(stat -c '%u' "$QL_DIR/data" 2>/dev/null || stat -f '%u' "$QL_DIR/data" 2>/dev/null)
      log_with_style "ERROR" "============================================="
      log_with_style "ERROR" "  权限错误：无法写入 /ql/data (Volume 挂载点)"
      log_with_style "ERROR" "  当前用户 UID: $current_uid"
      log_with_style "ERROR" "  /ql/data 所有者 UID: ${data_owner:-未知}"
      log_with_style "ERROR" ""
      log_with_style "ERROR" "  请修正宿主机数据目录权限："
      log_with_style "ERROR" "  chown -R $current_uid:$current_gid /your/ql/data"
      log_with_style "ERROR" "============================================="
      exit 1
    fi
  fi
}

# Fix DNS resolution issues in Alpine Linux
if [ -f /etc/alpine-release ]; then
  if ! grep -q "^options ndots:0" /etc/resolv.conf 2>/dev/null; then
    echo "options ndots:0" >> /etc/resolv.conf
    log_with_style "INFO" "🔧  0. 已配置 DNS 解析优化 (ndots:0)"
  fi
fi

# 确保 /etc/hosts 包含 localhost 解析（应对精简镜像或仅 IPv4/IPv6 环境）
if ! grep -qE '^127\.0\.0\.1[[:space:]]+.*localhost' /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 localhost" >> /etc/hosts
  log_with_style "INFO" "🔧  0. 已添加 IPv4 localhost 解析"
fi
if ! grep -qE '^::1[[:space:]]+.*localhost' /etc/hosts 2>/dev/null; then
  echo "::1 localhost ip6-localhost ip6-loopback" >> /etc/hosts
  log_with_style "INFO" "🔧  0. 已添加 IPv6 localhost 解析"
fi

# 自定义用户（非 qinglong/root）可能 HOME 为空或不可写
# 修正 HOME 确保 npm/pip/pm2 等工具有可用的缓存目录
if [ ! -w "$HOME" ]; then
  mkdir -p "$QL_DIR/.tmp"
  export HOME="$QL_DIR/.tmp"
fi

# 在一切操作之前检查目录权限
ensure_ql_permissions

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

# 自动检测调度模式：有 crond 二进制 → system 模式，否则 node 模式
if [ -z "$QL_SCHEDULER" ]; then
  if command -v crond &>/dev/null; then
    export QL_SCHEDULER="system"
  else
    export QL_SCHEDULER="node"
  fi
fi

if [ "$QL_SCHEDULER" = "system" ]; then
  crond -f > /dev/null
else
  tail -f /dev/null
fi

exec "$@"
