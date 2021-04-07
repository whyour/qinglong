#!/bin/bash
set -e

echo -e "======================1. 更新源代码========================\n"
update ql
echo

echo -e "======================2. 检测配置文件========================\n"
[ ! -d ${QL_DIR}/config ] && mkdir -p ${QL_DIR}/config

if [ ! -s ${QL_DIR}/config/crontab.list ]
then
    echo -e "检测到config配置目录下不存在crontab.list或存在但文件为空，从示例文件复制一份用于初始化...\n"
    cp -fv ${QL_DIR}/sample/crontab.sample.list ${QL_DIR}/config/crontab.list
    perl -i -pe "{s|CMD_UPDATE|update|g; s|CMD_REBUILD|rebuild|g; s|CMD_RMLOG|rmlog|g; s|CMD_TASK|task|g; s|CMD_MYTASK|mytask|g}" ${QL_DIR}/config/crontab.list
fi
crontab ${QL_DIR}/config/crontab.list
echo -e "成功添加定时任务...\n"

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

echo -e "======================3. 启动nginx========================\n"
nginx -c /etc/nginx/nginx.conf
echo

echo -e "======================4. 启动控制面板========================\n"
pm2 start ${QL_DIR}/build/app.js -n panel
echo -e "控制面板启动成功...\n"

echo -e "\n容器启动成功...\n"

crond -f

exec "$@"