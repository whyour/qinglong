#!/bin/bash
set -e

dir_shell=/ql/shell
. $dir_shell/share.sh
link_shell
echo -e "======================1. 更新源代码========================\n"
ql update
echo

echo -e "======================2. 检测配置文件========================\n"
fix_config
cp -fv $dir_root/docker/front.conf /etc/nginx/conf.d/front.conf
echo

echo -e "======================3. 启动nginx========================\n"
nginx -s reload 2>/dev/null || nginx -c /etc/nginx/nginx.conf
echo -e "nginx启动成功...\n"

echo -e "======================4. 启动控制面板========================\n"
cd $dir_root
pm2 restart panel 2>/dev/null || pm2 start $dir_root/build/app.js -n panel
echo -e "控制面板启动成功...\n"

echo -e "======================5. 启动定时任务========================\n"
cd $dir_root
pm2 restart schedule 2>/dev/null || pm2 start $dir_root/build/schedule.js -n schedule
echo -e "定时任务启动成功...\n"

echo -e "############################################################"
echo -e "容器启动成功..."
echo -e "\n请先访问5700端口，登录面板成功之后先手动执行一次git_pull命令..."
echo -e "\n如果需要启动挂机程序手动执行docker exec -it qinglong js hangup..."
echo -e "\n或者去cron管理搜索hangup手动执行挂机任务..."
echo -e "############################################################"

crond -f

exec "$@"