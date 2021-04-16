#!/usr/bin/env bash
#author:spark thanks to: https://github.com/sparkssssssss/scripts

ShellDir=${QL_DIR:-$(
  cd $(dirname $0)
  pwd
)}
[[ $QL_DIR ]] && ShellJs=js
ConfigDir=$ShellDir/config
ListCronCurrent=$ConfigDir/crontab.list
AuthConf=$ConfigDir/auth.json

declare -A BlackListDict
url=$1
path=$3
blackword=$4

if [[ $# -lt 2 ]] || [[ $# -gt 4 ]]; then
  echo 'Desc: 用户拉取指定用户的指定仓储'
  echo 'Usage: diy <auth> <repo> <path> <blacklist>'

  echo 'auth  作者名'
  echo 'repo  仓储名'
  echo 'path  需要下载脚本的指定目录，多个目录 | 分割  path1 | path2'
  echo 'blacklist  需要排除的脚本名，多个名称 | 分割  blacklist1 | blacklist2'
  exit 0
fi

diyscriptsdir=/ql/diyscripts
mkdir -p ${diyscriptsdir}

if [ ! -d "$diyscriptsdir/${author}_${repo}" ]; then
  echo -e "${author}本地仓库不存在,从远程拉取ing..."
  repoTmp=${url##*/}
  repo=${repoTmpName%.*}
  tmp=${url%/*}
  author=${tmp##*/}
  cd ${diyscriptsdir} && git clone $url ${author}_${repo}
  gitpullstatus=$?
  [ $gitpullstatus -eq 0 ] && echo -e "${author}本地仓库拉取完毕"
  [ $gitpullstatus -ne 0 ] && echo -e "${author}本地仓库拉取失败,请检查!" && exit 0
else
  cd ${diyscriptsdir}/${author}_${repo}
  branch=$(git symbolic-ref --short -q HEAD)
  git fetch --all
  git reset --hard origin/$branch
  git pull
  gitpullstatus=$?
fi

rand() {
  min=$1
  max=$(($2 - $min + 1))
  num=$(cat /proc/sys/kernel/random/uuid | cksum | awk -F ' ' '{print $1}')
  echo $(($num % $max + $min))
}

addnewcron() {
  addname=""
  cd ${diyscriptsdir}/${author}_${repo}
  express=$(find . -name "*.js")
  if [ $path ]; then
    express=$(find . -name "*.js" | egrep $path)
  fi
  if [ $blackword ]; then
    express=$(find . -name "*.js" | egrep -v $blackword | egrep $path)
  fi
  for js in $express; do
    base=$(basename $js)
    croname=$(echo "${author}_$base" | awk -F\. '{print $1}')
    script_date=$(cat $js | grep ^[0-9] | awk '{print $1,$2,$3,$4,$5}' | egrep -v "[a-zA-Z]|:|\." | sort | uniq | head -n 1)
    [ -z "${script_date}" ] && script_date=$(cat $js | grep -Eo "([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9][,-].*)" | sort | uniq | head -n 1)
    [ -z "${script_date}" ] && cron_min=$(rand 1 59) && cron_hour=$(rand 7 9) && script_date="${cron_min} ${cron_hour} * * *"
    local oldCron=$(grep -c -w "$croname" "$ListCronCurrent")
    if [[ oldCron -eq 0 ]]; then
      local name=$(cat "$js" | grep -E "new Env\(" | perl -pe "s|(^.+)new Env\(\'*\"*(.+?)'*\"*\).+|\2|")
      add_cron_api "$script_date" "js $croname" "$name"
      addname="${addname}\n${croname}"
      echo -e "添加了新的脚本${croname}."
    fi
    if [ ! -f "/ql/scripts/${author}_$base" ]; then
      \cp $js /ql/scripts/${author}_$base
    else
      change=$(diff $js /ql/scripts/${author}_$base)
      [ -n "${change}" ] && \cp $js /ql/scripts/${author}_$base && echo -e "${author}_$base 脚本更新了."
    fi
  done
  [ "$addname" != "" ] && notify "新增 ${author} 自定义脚本" "${addname}"

}

delcron() {
  delname=""
  cronfiles=$(grep "$author" /ql/config/crontab.list | grep -v "^#" | perl -pe "s|.*ID=(.*) js (${author}_.*)\.*|\1:\2|")
  for filename in $cronfiles; do
    local id=$(echo "$1" | awk -F ":" '{print $1}')
    local name=$(echo "$1" | awk -F ":" '{print $2}')
    hasFile=$(cd ${diyscriptsdir}/${author}_${repo} && find . -name "$filename.js" | wc -l)
    if [[ $hasFile != 0 ]]; then
      del_cron_api "$id"
      echo -e "删除失效脚本${name}."
      delname="${delname}\n${author}_${filename}"
    fi
  done
  [ "$delname" != "" ] && notify "删除 ${author} 失效脚本" "${delname}"
}

. $ShellDir/shell/api.sh
get_token

if [[ ${gitpullstatus} -eq 0 ]]; then
  addnewcron
  delcron
else
  echo -e "$author 仓库更新失败了."
  notify "自定义仓库更新失败" "$author"
fi

exit 0
