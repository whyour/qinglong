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
  t '---> 服务诊断信息'
  pm2 status || true

  local systemLogDir="$dir_data/syslog"
  local latestSystemLog
  latestSystemLog=$(find "$systemLogDir" -maxdepth 1 -type f -name '*.log' 2>/dev/null | sort | tail -n 1)
  if [[ -n "$latestSystemLog" ]]; then
    t '---> 最近的系统日志: %s' "$latestSystemLog"
    tail -n 300 "$latestSystemLog"
  else
    t '---> 未找到系统日志: %s' "$systemLogDir"
  fi

  if [[ "$QL_CONTAINER" == "true" ]]; then
    t '---> 容器内 PM2 日志不落盘；早期启动错误请执行 docker logs --tail 300 <容器名>'
    return
  fi

  local pm2Home="${PM2_HOME:-$HOME/.pm2}"
  local panelOut="$pm2Home/logs/qinglong-out.log"
  local panelError="$pm2Home/logs/qinglong-error.log"
  [[ -f "$panelOut" ]] && tail -n 300 "$panelOut"
  [[ -f "$panelError" ]] && tail -n 300 "$panelError"
}

check_ql() {
  local basePath="${ql_base_url%/}"
  local api
  local attempt
  for ((attempt = 1; attempt <= 10; attempt++)); do
    api=$(curl -s --max-time 2 --noproxy "*" "http://localhost:${ql_port}${basePath}/")
    [[ $api =~ "<div id=\"root\"></div>" ]] && break
    sleep 1
  done
  t '\n=====> 检测面板'
  echo -e "\n\n$api\n"
  if [[ $api =~ "<div id=\"root\"></div>" ]]; then
    t '=====> 面板服务启动正常\n'
  else
    t '=====> 面板服务启动异常，请检查上方诊断信息\n'
    return 1
  fi
}

check_pm2() {
  local currentTimeStamp=$(date +%s)
  local basePath="${ql_base_url%/}"
  local api
  local attempt
  for ((attempt = 1; attempt <= 10; attempt++)); do
    api=$(
      curl -s --max-time 2 --noproxy "*" "http://localhost:${ql_port}${basePath}/api/health?t=$currentTimeStamp" \
        -H 'Accept: */*' \
        -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36' \
        -H "Referer: http://localhost:${ql_port}/crontab" \
        -H 'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7' \
        --compressed
    )
    [[ $api == *'"code":200'* && $api == *'"status":"ok"'* ]] && break
    sleep 1
  done
  t '\n=====> 检测后台'
  echo -e "\n\n$api\n"
  if [[ $api == *'"code":200'* && $api == *'"status":"ok"'* ]]; then
    t '=====> 后台服务启动正常\n'
  else
    pm2_log
    t '=====> 后台服务启动异常，请检查上方诊断信息\n'
    return 1
  fi
}

main() {
  t '=====> 开始检测'
  npm i -g pnpm@8.3.1 pm2 ts-node typescript@5

  reset_env
  copy_dep
  reload_pm2
  local checkStatus=0
  check_ql || checkStatus=1
  check_pm2 || checkStatus=1
  t '\n=====> 检测结束\n'
  return $checkStatus
}

main
