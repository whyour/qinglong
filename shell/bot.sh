#!/usr/bin/env bash

if [[ -z ${BotRepoUrl} ]]; then
  url="https://github.com/SuMaiKaDe/bot.git"
  repo_path="${dir_repo}/dockerbot"
else
  url=${BotRepoUrl}
  repo_path="${dir_repo}/diybot"
fi

t '\n1、安装bot依赖...\n'
os_name="${QL_OS_TYPE:-}"
if [ -z "$os_name" ]; then
  os_name=$(source /etc/os-release && echo "$ID")
fi

# 非 root 用户使用 sudo
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

case "$os_name" in
  alpine)
    $SUDO apk --no-cache add -f zlib-dev gcc jpeg-dev python3-dev musl-dev freetype-dev
    ;;
  debian|ubuntu)
    $SUDO apt-get install -y gcc python3-dev musl-dev zlib1g-dev libjpeg-dev libfreetype-dev
    ;;
  *)
    t '暂不支持此系统 %s' "$os_name"
    exit 1
    ;;
esac
t '\nbot依赖安装成功...\n'

t '2、下载bot所需文件...\n'
if [[ ! -d ${repo_path}/.git ]]; then
  rm -rf ${repo_path}
  git_clone_scripts ${url} ${repo_path} "main"
fi

cp -rf "$repo_path/jbot" $dir_data
if [[ ! -f "$dir_config/bot.json" ]]; then
  cp -f "$repo_path/config/bot.json" "$dir_config"
fi
t '\nbot文件下载成功...\n'

t '3、安装python3依赖...\n'
cp -f "$repo_path/jbot/requirements.txt" "$dir_data"

cd $dir_data
cat requirements.txt | while read LREAD; do
  if [[ ! $(pip3 show "${LREAD%%=*}" 2>/dev/null) ]]; then
    pip3 --default-timeout=100 install ${LREAD}
  fi
done

t '\npython3依赖安装成功...\n'

t '4、启动bot程序...\n'
make_dir $dir_log/bot
cd $dir_data
ps -eo pid,command | grep "python3 -m jbot" | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null
nohup python3 -m jbot >$dir_log/bot/nohup.log 2>&1 &
t 'bot启动成功...\n'
