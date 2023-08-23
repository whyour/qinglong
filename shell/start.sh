#!/usr/bin/env bash

# 前置依赖 nodejs、npm
set -e
set -x

if [[ ! $QL_DIR ]]; then
  npm_dir=$(npm root -g)
  pnpm_dir=$(pnpm root -g)
  if [[ -d "$npm_dir/@whyour/qinglong" ]]; then
    QL_DIR="$npm_dir/@whyour/qinglong"
  elif [[ -d "$pnpm_dir/@whyour/qinglong" ]]; then
    QL_DIR="$pnpm_dir/@whyour/qinglong"
  else
    echo -e "未找到 qinglong 模块，请先执行 npm i -g @whyour/qinglong 安装"
  fi

  if [[ $QL_DIR ]]; then
    echo -e "请先设置 export QL_DIR=$QL_DIR，环境变量，并添加到系统环境变量，然后再次执行命令 qinglong 启动服务"
  fi

  exit 1
fi

if [[ ! $QL_DATA_DIR ]]; then
  echo -e "请先设置数据存储目录 export QL_DATA_DIR 环境变量，目录必须以斜杠开头的绝对路径，并添加到系统环境变量"
  exit 1
fi

# 安装依赖
os_name=$(source /etc/os-release && echo "$ID")

if [[ $os_name == 'alpine' ]]; then
  apk update
  apk add -f bash \
    coreutils \
    git \
    curl \
    wget \
    tzdata \
    perl \
    openssl \
    jq \
    nginx \
    openssh \
    procps \
    netcat-openbsd
elif [[ $os_name == 'debian' ]] || [[ $os_name == 'ubuntu' ]]; then
  apt update
  apt install -y git curl wget tzdata perl openssl jq nginx procps netcat openssh-client
elif [[ $os_name == 'centos' ]]; then
  yum update
  yum install -y epel-release git curl wget tzdata perl openssl jq nginx procps netcat openssh-client
else
  echo -e "暂不支持此系统部署 $os_name"
  exit 1
fi

npm install -g pnpm@8.3.1
cd && pnpm config set registry https://registry.npmmirror.com
pnpm add -g pm2 tsx

cd ${QL_DIR}
cp -f .env.example .env
chmod 777 ${QL_DIR}/shell/*.sh

. ${QL_DIR}/shell/share.sh

make_dir /etc/nginx/conf.d
make_dir /run/nginx
init_nginx
fix_config

pm2 l &>/dev/null

patch_version
if [[ $PipMirror ]]; then
  pip3 config set global.index-url $PipMirror
fi
current_npm_registry=$(cd && pnpm config get registry)
is_equal_registry=$(echo $current_npm_registry | grep "${NpmMirror}")
if [[ "$is_equal_registry" == "" ]]; then
  cd && pnpm config set registry $NpmMirror
  pnpm install -g
fi
update_depend

reload_pm2

nginx -s reload 2>/dev/null || nginx -c /etc/nginx/nginx.conf

if [[ $AutoStartBot == true ]]; then
  nohup ql -l bot >$dir_log/bot.log 2>&1 &
fi

if [[ $EnableExtraShell == true ]]; then
  nohup ql -l extra >$dir_log/extra.log 2>&1 &
fi
