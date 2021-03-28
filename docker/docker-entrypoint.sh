#!/bin/bash
set -e

echo -e "======================1. 检测配置文件========================\n"
[ ! -d ${QL_DIR}/config ] && mkdir -p ${QL_DIR}/config

if [ ! -s ${QL_DIR}/config/crontab.list ]
then
  echo -e "检测到config配置目录下不存在crontab.list或存在但文件为空，从示例文件复制一份用于初始化...\n"
  cp -fv ${QL_DIR}/sample/crontab.list.sample ${QL_DIR}/config/crontab.list
  sed -i "s,MY_PATH,${QL_DIR},g" ${QL_DIR}/config/crontab.list
  sed -i "s,ENV_PATH=,PATH=$PATH,g" ${QL_DIR}/config/crontab.list
fi
crond
crontab ${QL_DIR}/config/crontab.list
echo -e "成功添加定时任务...\n"

if [ ! -s ${QL_DIR}/config/cookie.sh ]; then
  echo -e "检测到config配置目录下不存在cookie.sh，从示例文件复制一份用于初始化...\n"
  touch ${QL_DIR}/config/cookie.sh
  echo
fi

if [ ! -s ${QL_DIR}/config/config.sh ]; then
  echo -e "检测到config配置目录下不存在config.sh，从示例文件复制一份用于初始化...\n"
  cp -fv ${QL_DIR}/sample/config.sh.sample ${QL_DIR}/config/config.sh
  echo
fi

if [ ! -s ${QL_DIR}/config/auth.json ]; then
  echo -e "检测到config配置目录下不存在auth.json，从示例文件复制一份用于初始化...\n"
  cp -fv ${QL_DIR}/sample/auth.json ${QL_DIR}/config/auth.json
  echo
fi

if [ -s /etc/nginx/conf.d/default.conf ]; then
  echo -e "检测到默认nginx配置文件，删除...\n"
  rm -f /etc/nginx/conf.d/default.conf
  echo
fi

cp -fv ${QL_DIR}/docker/front.conf /etc/nginx/conf.d/front.conf

echo -e "======================2. 启动nginx========================\n"
nginx -c /etc/nginx/nginx.conf
echo

echo -e "======================3. 更新源代码========================\n"
git_pull
echo

echo -e "======================4. 启动挂机程序========================\n"
CookieConf=${QL_DIR}/config/cookie.sh
. ${QL_DIR}/config/config.sh
. ${CookieConf}
if [ -s ${CookieConf} ]; then
  js hangup 2>/dev/null
  echo -e "挂机程序启动成功...\n"
else
  echo -e "尚未在Cookie管理中添加一条Cookie，可能是首次部署容器，因此不启动挂机程序...\n"
fi

echo -e "======================5. 启动控制面板========================\n"
  pm2 start ${QL_DIR}/build/app.js -n panel
  echo -e "控制面板启动成功...\n"

echo -e "\n容器启动成功...\n"

if [ "${1#-}" != "${1}" ] || [ -z "$(command -v "${1}")" ]; then
  set -- node "$@"
fi

exec "$@"