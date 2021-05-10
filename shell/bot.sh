#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh
repo_path="${dir_repo}/SuMaiKaDe_jddockerbot"

echo -e "1、安装bot依赖...\n"
apk --no-cache add -f zlib-dev gcc jpeg-dev python3-dev musl-dev freetype-dev
echo

echo -e "2、下载bot所需文件...\n"
git clone -b master https://ghproxy.com/https://github.com/SuMaiKaDe/jddockerbot.git $repo_path
cp -rf "$repo_path/jbot" $dir_root
if [[ ! -f "$dir_root/config/bot.json" ]]; then
  cp -f "$repo_path/config/bot.json" "$dir_root/config"
fi
echo

echo -e "3、安装python3依赖...\n"
pip3 config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
cp -f "$repo_path/jbot/requirements.txt" "$dir_root"
pip3 --default-timeout=100 install -r requirements.txt --no-cache-dir
echo

echo -e "4、启动bot程序...\n"
cd $dir_root
ps -ef | grep "python3 -m jbot" | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null
nohup python3 -m jbot & >/dev/null 2>&1
echo

exit 0
