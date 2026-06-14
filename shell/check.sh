#!/usr/bin/env bash

reset_env() {
  t '---> 1. 开始检测配置文件\n'
  fix_config
  t '---> 配置文件检测完成\n'

  t '---> 2. 开始安装青龙依赖\n'
  npm_install_2 $dir_root
  t '---> 青龙依赖安装完成\n'

  t '---> 脚本依赖安装完成\n'
}

copy_dep() {
  t '---> 1. 复制通知文件\n'
  t '---> 复制一份 %s 为 %s\n' "$file_notify_py_sample" "$file_notify_py"
  cp -fv $file_notify_py_sample $file_notify_py
  echo
  t '---> 复制一份 %s 为 %s\n' "$file_notify_js_sample" "$file_notify_js"
  cp -fv $file_notify_js_sample $file_notify_js
  t '---> 通知文件复制完成\n'
}

pm2_log() {
  t '---> pm2日志'
  local panelOut="/root/.pm2/logs/qinglong-out.log"
  local panelError="/root/.pm2/logs/qinglong-error.log"
  tail -n 300 "$panelOut"
  tail -n 300 "$panelError"
}

check_ql() {
  local api=$(curl -s --noproxy "*" "http://localhost:${ql_port}")
  t '\n=====> 检测面板'
  echo -e "\n\n$api\n"
  if [[ $api =~ "<div id=\"root\"></div>" ]]; then
    t '=====> 面板服务启动正常\n'
  fi
}

check_pm2() {
  pm2_log
  local currentTimeStamp=$(date +%s)
  local api=$(
    curl -s --noproxy "*" "http://localhost:${ql_port}/api/system?t=$currentTimeStamp" \
      -H 'Accept: */*' \
      -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36' \
      -H "Referer: http://localhost:${ql_port}/crontab" \
      -H 'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7' \
      --compressed
  )
  t '\n=====> 检测后台'
  echo -e "\n\n$api\n"
  if [[ $api =~ "{\"code\"" ]]; then
    t '=====> 后台服务启动正常\n'
  fi
}

main() {
  t '=====> 开始检测'
  npm i -g pnpm@8.3.1 pm2 ts-node

  reset_env
  copy_dep
  check_ql
  check_pm2
  reload_pm2
  t '\n=====> 检测结束\n'
}

main
