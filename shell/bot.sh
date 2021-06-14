#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh
url="${github_proxy_url}https://github.com/SuMaiKaDe/bot.git"
repo_path="${dir_repo}/dockerbot"

echo -e "\n1、安装bot依赖...\n"
apk --no-cache add -f zlib-dev gcc jpeg-dev python3-dev musl-dev freetype-dev
echo -e "\nbot依赖安装成功...\n"

echo -e "2、下载bot所需文件...\n"
if [ -d ${repo_path}/.git ]; then
    git_pull_scripts ${repo_path}
else
  rm -rf ${repo_path}
  git_clone_scripts ${url} ${repo_path} "main"
fi

cp -rf "$repo_path/jbot" $dir_root
if [[ ! -f "$dir_root/config/bot.json" ]]; then
  cp -f "$repo_path/config/bot.json" "$dir_root/config"
fi
echo -e "\nbot文件下载成功...\n"

echo -e "3、安装python3依赖...\n"
if [[ $PipMirror ]]; then
  pip3 config set global.index-url $PipMirror
fi
cp -f "$repo_path/jbot/requirements.txt" "$dir_root"
pip3 --default-timeout=100 install -r requirements.txt --no-cache-dir
echo -e "\npython3依赖安装成功...\n"

echo -e "4、启动bot程序...\n"
make_dir $dir_log/bot
cd $dir_root
ps -ef | grep "python3 -m jbot" | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null
nohup python3 -m jbot >$dir_log/bot/nohup.log 2>&1 &
echo -e "bot启动成功...\n"

exit 0
