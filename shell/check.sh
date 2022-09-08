#!/usr/bin/env bash

dir_shell=$QL_DIR/shell
. $dir_shell/share.sh
. $dir_shell/api.sh

reset_env() {
  echo -e "---> 1. 开始检测配置文件\n"
  fix_config
  echo -e "---> 配置文件检测完成\n"

  echo -e "---> 2. 开始安装青龙依赖\n"
  npm_install_2 $dir_root
  echo -e "---> 青龙依赖安装完成\n"

  echo -e "---> 3. 开始安装脚本依赖\n"
  cp -f $dir_sample/package.json $dir_scripts/package.json
  npm_install_2 $dir_scripts
  echo -e "---> 脚本依赖安装完成\n"
}

copy_dep() {
  echo -e "---> 1. 复制通知文件\n"
  echo -e "---> 复制一份 $file_notify_py_sample 为 $file_notify_py\n"
  cp -fv $file_notify_py_sample $file_notify_py
  echo
  echo -e "---> 复制一份 $file_notify_js_sample 为 $file_notify_js\n"
  cp -fv $file_notify_js_sample $file_notify_js
  echo -e "---> 通知文件复制完成\n"

  echo -e "---> 2. 复制nginx配置文件\n"
  cp -fv $nginx_conf /etc/nginx/nginx.conf
  cp -fv $nginx_app_conf /etc/nginx/conf.d/front.conf
  sed -i "s,QL_BASE_URL,${qlBaseUrl},g" /etc/nginx/conf.d/front.conf
  echo -e "---> 配置文件复制完成\n"
}

pm2_log() {
  echo -e "---> pm2日志"
  local panelOut="/root/.pm2/logs/panel-out.log"
  local panelError="/root/.pm2/logs/panel-error.log"
  tail -n 100 "$panelOut"
  tail -n 100 "$panelError"
}

check_nginx() {
  local nginxPid=$(ps -ef | grep nginx | grep -v grep)
  echo -e "=====> 检测nginx服务\n$nginxPid"
  if [[ $nginxPid ]]; then
    echo -e "\n=====> nginx服务正常\n"
    nginx -s reload
  else
    echo -e "\n=====> nginx服务异常，重新启动nginx\n"
    nginx -c /etc/nginx/nginx.conf
  fi
}

check_ql() {
  local api=$(curl -s --noproxy "*" "http://0.0.0.0:5700")
  echo -e "\n=====> 检测面板\n\n$api\n"
  if [[ $api =~ "<div id=\"root\"></div>" ]]; then
    echo -e "=====> 面板服务启动正常\n"
  else
    echo -e "=====> 面板服务异常，重置基础环境\n"
    reset_env
  fi
}

check_pm2() {
  pm2_log
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://0.0.0.0:5600/api/user?t=$currentTimeStamp" \
      -H 'Accept: */*' \
      -H "Authorization: Bearer $token" \
      -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36' \
      -H 'Referer: http://0.0.0.0:5700/crontab' \
      -H 'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7' \
      --compressed
  )
  echo -e "\n=====> 检测后台\n\n$api\n"
  if [[ $api =~ "{\"code\"" ]]; then
    echo -e "=====> 后台服务启动正常\n"
  else
    echo -e "=====> 后台服务异常，重置基础环境并重启后台\n"
    reset_env
  fi
}

main() {
  echo -e "=====> 开始检测"
  npm i -g pnpm
  pnpm setup &>/dev/null
  source ~/.bashrc
  pnpm install -g &>/dev/null
  pnpm add -g pm2
  copy_dep
  check_ql
  check_nginx
  check_pm2
  reload_pm2
  echo -e "\n=====> 检测结束\n"
}

main
