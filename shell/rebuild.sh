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
yarn install --registry=https://registry.npm.taobao.org
yarn build
yarn build-back
echo -e "重新build完成...\n"

echo -e "重启服务...\n"

pm2 restart panel
nginx -s reload

echo -e "重启服务完成...\n"