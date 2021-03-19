#!/usr/bin/env bash

## 判断环境
ShellDir=${JD_DIR:-$(cd $(dirname $0); pwd)}
LogDir=${ShellDir}/log

## 导入配置文件
. ${ShellDir}/config/config.sh

## 删除运行js脚本的旧日志
function Rm_JsLog {
  LogFileList=$(ls -l ${LogDir}/*/*.log | awk '{print $9}')
  for log in ${LogFileList}
  do
    LogDate=$(echo ${log} | awk -F "/" '{print $NF}' | cut -c1-10)   #文件名比文件属性获得的日期要可靠
    if [[ $(uname -s) == Darwin ]]
    then
      DiffTime=$(($(date +%s) - $(date -j -f "%Y-%m-%d" "${LogDate}" +%s)))
    else
      DiffTime=$(($(date +%s) - $(date +%s -d "${LogDate}")))
    fi
    [ ${DiffTime} -gt $((${RmLogDaysAgo} * 86400)) ] && rm -vf ${log}
  done
}

## 删除git_pull.sh的运行日志
function Rm_GitPullLog {
  if [[ $(uname -s) == Darwin ]]
  then
    DateDelLog=$(date -v-${RmLogDaysAgo}d "+%Y-%m-%d")
  else
    Stmp=$(($(date "+%s") - 86400 * ${RmLogDaysAgo}))
    DateDelLog=$(date -d "@${Stmp}" "+%Y-%m-%d")
  fi
  LineEndGitPull=$[$(cat ${LogDir}/git_pull.log | grep -n "${DateDelLog} " | head -1 | awk -F ":" '{print $1}') - 3]
  [ ${LineEndGitPull} -gt 0 ] && perl -i -ne "{print unless 1 .. ${LineEndGitPull} }" ${LogDir}/git_pull.log
}

## 删除空文件夹
function Rm_EmptyDir {
  cd ${LogDir}
  for dir in $(ls)
  do
    if [ -d ${dir} ] && [[ $(ls ${dir}) == "" ]]; then
      rm -rf ${dir}
    fi
  done
}

## 运行
if [ -n "${RmLogDaysAgo}" ]; then
  echo -e "查找旧日志文件中...\n"
  Rm_JsLog
  Rm_GitPullLog
  Rm_EmptyDir
  echo -e "删除旧日志执行完毕\n"
fi
