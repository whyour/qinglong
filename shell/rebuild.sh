#!/usr/bin/env bash

ShellDir=${JD_DIR:-$(cd $(dirname $0); pwd)}
JD_DIR=/jd

echo -e "更新shell...\n"
cd ${ShellDir}
git fetch --all
git stash
git pull
git stash pop
git reset --mixed
echo -e "更新shell完成...\n"

echo -e "重新build...\n"
yarn install
yarn build
yarn build-back
echo -e "重新build完成...\n"

echo -e "重启服务...\n"

pm2 start ${JD_DIR}/build/app.js
nginx -s reload

echo -e "重启服务完成...\n"