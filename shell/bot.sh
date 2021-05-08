#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh

echo -e "1、安装bot依赖...\n"
apk --no-cache add -f zlib-dev gcc jpeg-dev python3-dev musl-dev freetype-dev
pip3 config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
pip3 install telethon python-socks[asyncio] pillow qrcode requests prettytable

echo -e "2、下载bot所需文件...\n"
repo_path="${dir_repo}/SuMaiKaDe_jddockerbot"
git clone -b master https://ghproxy.com/https://github.com/SuMaiKaDe/jddockerbot.git $repo_path
cp -rf "$repo_path/jbot" $dir_root
cp -f "$repo_path/config/bot.json" "$dir_root/config"

echo -e "3、启动bot程序...\n"
cd $dir_root
ps -ef | grep "python3 -m jbot" | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null
nohup python3 -m jbot &

exit 0
