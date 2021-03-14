#!/usr/bin/env bash

## 判断环境
ShellDir=${JD_DIR:-$(cd $(dirname $0); pwd)}
LogDir=${ShellDir}/log
Income=${LogDir}/bean_income.csv
Outlay=${LogDir}/bean_outlay.csv

## 执行
cd ${LogDir}/jd_bean_change
for log in $(ls); do
  LogDate=$(echo ${log} | cut -c1-10)
  BeanDate=$(date "+%Y-%m-%d" -d "1 day ago ${LogDate}")

  if [[ -z $(grep "${BeanDate}" ${Income}) ]]; then
    echo -n "${BeanDate}," >> ${Income}
    grep -E "昨日收入" ${log} | grep -oE "\d+" | perl -0777 -pe "s|\n(\d+)|,\1|g" >> ${Income}
  fi

  if [[ -z $(grep "${BeanDate}" ${Outlay}) ]]; then
    echo -n "${BeanDate}," >> ${Outlay}
    grep -E "昨日支出" ${log} | grep -oE "\d+" | perl -0777 -pe "s|\n(\d+)|,\1|g" >> ${Outlay}
  fi
done
