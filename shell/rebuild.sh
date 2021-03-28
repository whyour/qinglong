#!/usr/bin/env bash

ShellDir=${QL_DIR:-$(cd $(dirname $0); pwd)}

echo -e "更新shell...\n"
cd ${ShellDir}
git fetch --all
git stash
git pull
git stash pop
git reset --mixed
echo -e "更新shell完成...\n"

echo -e "重新build...\n"
yarn build
yarn build-back
echo -e "重新build完成...\n"

echo -e "重启服务...\n"

PIDS=`ps -ef|grep "app.js"|grep -v grep`
if [ "$PIDS" != "" ]; then
  pm2 restart panel
else
  pm2 start ${QL_DIR}/build/app.js -n panel
fi

nginx -s reload

echo -e "重启服务完成...\n"