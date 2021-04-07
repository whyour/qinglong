#!/usr/bin/env bash

dir_shell=$(dirname $(readlink -f "$0"))
dir_root=$(cd $dir_shell; cd ..; pwd)

echo -e "更新qinglong...\n"
cd $dir_root
git fetch --all
git pull
echo -e "更新更新qinglong完成...\n"

echo -e "重新build...\n"
yarn build
yarn build-back
echo -e "重新build完成...\n"

echo -e "重启服务...\n"
pm2 restart panel || pm2 start $dir_root/build/app.js -n panel 2>/dev/null
nginx -s reload

echo -e "重启服务完成...\n"