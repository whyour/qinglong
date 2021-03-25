#!/usr/bin/env bash
#author:spark thanks to: https://github.com/sparkssssssss/scripts

declare -A BlackListDict
author=$1
repo=$2
#指定仓库屏蔽关键词,不添加计划任务,多个按照格式二
BlackListDict['i-chenzhe']="_get"
BlackListDict['sparkssssssss']="smzdm|tg|xxxxxxxx"

blackword=${BlackListDict["${author}"]}
blackword=${blackword:-"wojiushigejimo"}

if [ $# != 2 ] ; then
  echo "USAGE: $0 author repo"
  exit 0;
fi

diyscriptsdir=/ql/diyscripts
mkdir -p ${diyscriptsdir}

if [ ! -d "$diyscriptsdir/${author}_${repo}" ]; then
  echo -e "${author}本地仓库不存在,从gayhub拉取ing..."
  cd ${diyscriptsdir} &&  git clone https://github.com.cnpmjs.org/${author}/${repo}.git ${author}_${repo}
  gitpullstatus=$?
  [ $gitpullstatus -eq 0 ] && echo -e "${author}本地仓库拉取完毕"
  [ $gitpullstatus -ne 0 ] && echo -e "${author}本地仓库拉取失败,请检查!" && exit 0
else
  cd ${diyscriptsdir}/${author}_${repo}
  branch=`git symbolic-ref --short -q HEAD`
  git fetch --all
  git reset --hard origin/$branch
  git pull
  gitpullstatus=$?
fi

rand(){
    min=$1
    max=$(($2-$min+1))
    num=$(cat /proc/sys/kernel/random/uuid | cksum | awk -F ' ' '{print $1}')
    echo $(($num%$max+$min))
}

function addnewcron {
  addname=""
  cd ${diyscriptsdir}/${author}_${repo}
  for js in `ls *.js|egrep -v $blackword`;
    do 
      croname=`echo "${author}_$js"|awk -F\. '{print $1}'`
      script_date=`cat  $js|grep ^[0-9]|awk '{print $1,$2,$3,$4,$5}'|egrep -v "[a-zA-Z]|:|\."|sort |uniq|head -n 1`
      [ -z "${script_date}" ] && script_date=`cat  $js|grep -Eo "([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9]+[,-].*) ([0-9]+|\*|[0-9][,-].*)"|sort |uniq|head -n 1`
      [ -z "${script_date}" ] && cron_min=$(rand 1 59) && cron_hour=$(rand 7 9) && script_date="${cron_min} ${cron_hour} * * *"
      [ $(grep -c -w "$croname" /ql/config/crontab.list) -eq 0 ] && sed -i "/hangup/a${script_date} js $croname"  /ql/config/crontab.list && addname="${addname}\n${croname}" && echo -e "添加了新的脚本${croname}." && js ${croname} now >/dev/null &
      if [ ! -f "/ql/scripts/${author}_$js" ];then
        \cp $js /ql/scripts/${author}_$js
      else
        change=$(diff $js /ql/scripts/${author}_$js)
        [ -n "${change}" ] && \cp $js /ql/scripts/${author}_$js && echo -e "${author}_$js 脚本更新了."
      fi
  done
  [ "$addname" != "" ] && notify "新增 ${author} 自定义脚本" "${addname}"

}

function delcron {
  delname=""
  cronfiles=$(grep "$author" /ql/config/crontab.list|grep -v "^#"|awk '{print $8}'|awk -F"${author}_" '{print $2}')
  for filename in $cronfiles;
    do
      if [ ! -f "${diyscriptsdir}/${author}_${repo}/${filename}.js" ]; then 
        sed -i "/\<js ${author}_${filename}\>/d" /ql/config/crontab.list && echo -e "删除失效脚本${filename}."
	delname="${delname}\n${author}_${filename}"
      fi
  done
  [ "$delname" != "" ] && notify  "删除 ${author} 失效脚本" "${delname}" 
}

if [[ ${gitpullstatus} -eq 0 ]]
then
  addnewcron
  delcron
else
  echo -e "$author 仓库更新失败了."
  notify "自定义仓库更新失败" "$author"
fi

exit 0
