#!/usr/bin/env bash

## 导入通用变量与函数
dir_shell=$QL_DIR/shell
. $dir_shell/share.sh

if [[ -z ${BotRepoUrl} ]]; then
  url="https://github.com/SuMaiKaDe/bot.git"
  repo_path="${dir_repo}/dockerbot"
else
  url=${BotRepoUrl}
  repo_path="${dir_repo}/diybot"
fi

echo -e "\n1、安装bot依赖...\n"
apk --no-cache add -f zlib-dev gcc jpeg-dev python3-dev musl-dev freetype-dev
echo -e "\nbot依赖安装成功...\n"

echo -e "2、下载bot所需文件...\n"
if [[ ! -d ${repo_path}/.git ]]; then
  rm -rf ${repo_path}
  git_clone_scripts ${url} ${repo_path} "main"
fi

cp -rf "$repo_path/jbot" $dir_data
if [[ ! -f "$dir_config/bot.json" ]]; then
  cp -f "$repo_path/config/bot.json" "$dir_config"
fi
echo -e "\nbot文件下载成功...\n"

echo -e "3、安装python3依赖...\n"
if [[ $PipMirror ]]; then
  pip3 config set global.index-url $PipMirror
fi
cp -f "$repo_path/jbot/requirements.txt" "$dir_data"

cd $dir_data
cat requirements.txt | while read LREAD
do
if [[ ! $(pip3 show "${LREAD%%=*}" 2>/dev/null) ]]; then
  pip3 --default-timeout=100 install ${LREAD}
fi
done

echo -e "\npython3依赖安装成功...\n"

echo -e "4、启动bot程序...\n"
make_dir $dir_log/bot
cd $dir_data
ps -ef | grep "python3 -m jbot" | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null
nohup python3 -m jbot >$dir_log/bot/nohup.log 2>&1 &
echo -e "bot启动成功...\n"
