#!/bin/bash
set -e

echo -e "======================1. 初始化命令========================\n"
dir_shell=/ql/shell
. $dir_shell/share.sh
link_shell
echo

echo -e "======================2. 更新源代码========================\n"
ql update
echo

echo -e "======================3. 检测配置文件========================\n"
fix_config
cp -fv $dir_root/docker/front.conf /etc/nginx/conf.d/front.conf

echo -e "======================4. 启动nginx========================\n"
nginx -c /etc/nginx/nginx.conf
echo

echo -e "======================5. 启动控制面板========================\n"
pm2 start $dir_root/build/app.js -n panel
echo -e "控制面板启动成功...\n"

echo -e "\n容器启动成功...\n"
echo -e "\n请先访问5700端口，登录面板成功之后先手动执行一次git_pull命令...\n"
echo -e "\n如果需要启动挂机程序手动执行docker exec -it qinglong js hangup...\n"
echo -e "\n或者去cron管理搜索hangup手动执行挂机任务...\n"

crond -f

exec "$@"