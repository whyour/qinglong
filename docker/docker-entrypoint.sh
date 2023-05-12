#!/bin/bash

dir_shell=/ql/shell
. $dir_shell/share.sh
link_shell

export isFirstStartServer=true

echo -e "======================1. 检测配置文件========================\n"
make_dir /etc/nginx/conf.d
make_dir /run/nginx
init_nginx
fix_config

pm2 l &>/dev/null

echo -e "======================2. 安装依赖========================\n"
patch_version
if [[ $PipMirror ]]; then
  pip3 config set global.index-url $PipMirror
fi
current_npm_registry=$(cd && pnpm config get registry)
is_equal_registry=$(echo $current_npm_registry | grep "${NpmMirror}")
if [[ "$is_equal_registry" == "" ]]; then
  cd && pnpm config set registry $NpmMirror
  pnpm install -g
fi
update_depend
echo

echo -e "======================3. 启动nginx========================\n"
nginx -s reload 2>/dev/null || nginx -c /etc/nginx/nginx.conf
echo -e "nginx启动成功...\n"

echo -e "======================4. 启动pm2服务========================\n"
reload_pm2

if [[ $AutoStartBot == true ]]; then
  echo -e "======================5. 启动bot========================\n"
  nohup ql -l bot >$dir_log/bot.log 2>&1 &
  echo -e "bot后台启动中...\n"
fi

if [[ $EnableExtraShell == true ]]; then
  echo -e "====================6. 执行自定义脚本========================\n"
  nohup ql -l extra >$dir_log/extra.log 2>&1 &
  echo -e "自定义脚本后台执行中...\n"
fi

echo -e "############################################################\n"
echo -e "容器启动成功..."
echo -e "############################################################\n"

crond -f >/dev/null

exec "$@"
