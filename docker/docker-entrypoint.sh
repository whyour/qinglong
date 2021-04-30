#!/bin/bash
set -e

echo -e "======================1. 初始化命令========================\n"
. ${QL_DIR}/shell/share.sh
link_shell
echo

echo -e "======================2. 更新源代码========================\n"
ql update
echo

echo -e "======================3. 检测配置文件========================\n"
[ ! -d ${QL_DIR}/config ] && mkdir -p ${QL_DIR}/config
[ ! -d ${QL_DIR}/log ] && mkdir -p ${QL_DIR}/log
[ ! -d ${QL_DIR}/db ] && mkdir -p ${QL_DIR}/db
[ ! -d ${QL_DIR}/manual_log ] && mkdir -p ${QL_DIR}/manual_log

if [ ! -s ${QL_DIR}/config/cookie.sh ]; then
    echo -e "检测到config配置目录下不存在cookie.sh，从示例文件复制一份用于初始化...\n"
    touch ${QL_DIR}/config/cookie.sh
    echo
fi

if [ ! -s ${QL_DIR}/config/config.sh ]; then
    echo -e "检测到config配置目录下不存在config.sh，从示例文件复制一份用于初始化...\n"
    cp -fv ${QL_DIR}/sample/config.sample.sh ${QL_DIR}/config/config.sh
    echo
fi

if [ ! -s ${QL_DIR}/config/auth.sample.json ]; then
    echo -e "检测到config配置目录下不存在auth.json，从示例文件复制一份用于初始化...\n"
    cp -fv ${QL_DIR}/sample/auth.sample.json ${QL_DIR}/config/auth.json
    echo
fi

if [ -s /etc/nginx/conf.d/default.conf ]; then
    echo -e "检测到默认nginx配置文件，删除...\n"
    rm -f /etc/nginx/conf.d/default.conf
    echo
fi

cp -fv ${QL_DIR}/docker/front.conf /etc/nginx/conf.d/front.conf

echo -e "======================4. 启动nginx========================\n"
nginx -c /etc/nginx/nginx.conf
echo

echo -e "======================5. 启动控制面板========================\n"
pm2 start ${QL_DIR}/build/app.js -n panel
echo -e "控制面板启动成功...\n"

echo -e "\n容器启动成功...\n"
echo -e "\n请先访问5700端口，登录面板成功之后先手动执行一次git_pull命令...\n"
echo -e "\n如果需要启动挂机程序手动执行docker exec -it qinglong js hangup...\n"
echo -e "\n或者去cron管理搜索hangup手动执行挂机任务...\n"

crond -f

exec "$@"