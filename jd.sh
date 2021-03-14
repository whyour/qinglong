#!/usr/bin/env bash

## 路径
ShellDir=${JD_DIR:-$(cd $(dirname $0); pwd)}
[[ ${JD_DIR} ]] && HelpJd=jd || HelpJd=jd.sh
[[ ${JD_DIR} ]] && ShellJd=jd || ShellJd=${ShellDir}/jd.sh
ScriptsDir=${ShellDir}/scripts
ConfigDir=${ShellDir}/config
FileConf=${ConfigDir}/config.sh
FileConfSample=${ShellDir}/sample/config.sh.sample
LogDir=${ShellDir}/log
ListScripts=($(cd ${ScriptsDir}; ls *.js | grep -E "j[drx]_"))
ListCron=${ConfigDir}/crontab.list
ListCronLxk=${ScriptsDir}/docker/crontab_list.sh
ListJs=${LogDir}/js.list

## 导入config.sh
function Import_Conf {
  if [ -f ${FileConf} ]
  then
    . ${FileConf}
    if [ -z "${Cookie1}" ]; then
      echo -e "请先在config.sh中配置好Cookie...\n"
      exit 1
    fi
  else
    echo -e "配置文件 ${FileConf} 不存在，请先按教程配置好该文件...\n"
    exit 1
  fi
}

## 更新crontab
function Detect_Cron {
  if [[ $(cat ${ListCron}) != $(crontab -l) ]]; then
    crontab ${ListCron}
  fi
}

## 用户数量UserSum
function Count_UserSum {
  for ((i=1; i<=1000; i++)); do
    Tmp=Cookie$i
    CookieTmp=${!Tmp}
    [[ ${CookieTmp} ]] && UserSum=$i || break
  done
}

## 组合Cookie和互助码子程序
function Combin_Sub {
  CombinAll=""
  if [[ ${AutoHelpOther} == true ]] && [[ $1 == ForOther* ]]; then

    ForOtherAll=""
    MyName=$(echo $1 | perl -pe "s|ForOther|My|")

    for ((m=1; m<=${UserSum}; m++)); do
      TmpA=${MyName}$m
      TmpB=${!TmpA}
      ForOtherAll="${ForOtherAll}@${TmpB}"
    done
    
    for ((n=1; n<=${UserSum}; n++)); do
      for num in ${TempBlockCookie}; do
        [[ $n -eq $num ]] && continue 2
      done
      CombinAll="${CombinAll}&${ForOtherAll}"
    done

  else
    for ((i=1; i<=${UserSum}; i++)); do
      for num in ${TempBlockCookie}; do
        [[ $i -eq $num ]] && continue 2
      done
      Tmp1=$1$i
      Tmp2=${!Tmp1}
      CombinAll="${CombinAll}&${Tmp2}"
    done
  fi

  echo ${CombinAll} | perl -pe "{s|^&||; s|^@+||; s|&@|&|g; s|@+&|&|g; s|@+|@|g; s|@+$||}"
}

## 组合Cookie、Token与互助码
function Combin_All {
  export JD_COOKIE=$(Combin_Sub Cookie)
  export FRUITSHARECODES=$(Combin_Sub ForOtherFruit)
  export PETSHARECODES=$(Combin_Sub ForOtherPet)
  export PLANT_BEAN_SHARECODES=$(Combin_Sub ForOtherBean)
  export DREAM_FACTORY_SHARE_CODES=$(Combin_Sub ForOtherDreamFactory)
  export DDFACTORY_SHARECODES=$(Combin_Sub ForOtherJdFactory)
  export JDZZ_SHARECODES=$(Combin_Sub ForOtherJdzz)
  export JDJOY_SHARECODES=$(Combin_Sub ForOtherJoy)
  export JXNC_SHARECODES=$(Combin_Sub ForOtherJxnc)
  export JXNCTOKENS=$(Combin_Sub TokenJxnc)
  export BOOKSHOP_SHARECODES=$(Combin_Sub ForOtherBookShop)
  export JD_CASH_SHARECODES=$(Combin_Sub ForOtherCash)
  export JDSGMH_SHARECODES=$(Combin_Sub ForOtherSgmh)
  export JDCFD_SHARECODES=$(Combin_Sub ForOtherCfd)
  export JDGLOBAL_SHARECODES=$(Combin_Sub ForOtherGlobal)
}

## 转换JD_BEAN_SIGN_STOP_NOTIFY或JD_BEAN_SIGN_NOTIFY_SIMPLE
function Trans_JD_BEAN_SIGN_NOTIFY {
  case ${NotifyBeanSign} in
    0)
      export JD_BEAN_SIGN_STOP_NOTIFY="true"
      ;;
    1)
      export JD_BEAN_SIGN_NOTIFY_SIMPLE="true"
      ;;
  esac
}

## 转换UN_SUBSCRIBES
function Trans_UN_SUBSCRIBES {
  export UN_SUBSCRIBES="${goodPageSize}\n${shopPageSize}\n${jdUnsubscribeStopGoods}\n${jdUnsubscribeStopShop}"
}

## 申明全部变量
function Set_Env {
  Count_UserSum
  Combin_All
  Trans_JD_BEAN_SIGN_NOTIFY
  Trans_UN_SUBSCRIBES
}

## 随机延迟
function Random_Delay {
  if [[ -n ${RandomDelay} ]] && [[ ${RandomDelay} -gt 0 ]]; then
    CurMin=$(date "+%-M")
    if [[ ${CurMin} -gt 2 && ${CurMin} -lt 30 ]] || [[ ${CurMin} -gt 31 && ${CurMin} -lt 59 ]]; then
      CurDelay=$((${RANDOM} % ${RandomDelay} + 1))
      echo -e "\n命令未添加 \"now\"，随机延迟 ${CurDelay} 秒后再执行任务，如需立即终止，请按 CTRL+C...\n"
      sleep ${CurDelay}
    fi
  fi
}

## 使用说明
function Help {
  echo -e "本脚本的用法为："
  echo -e "1. bash ${HelpJd} xxx      # 如果设置了随机延迟并且当时时间不在0-2、30-31、59分内，将随机延迟一定秒数"
  echo -e "2. bash ${HelpJd} xxx now  # 无论是否设置了随机延迟，均立即运行"
  echo -e "3. bash ${HelpJd} runall   # 运行所有非挂机脚本，非常耗时"
  echo -e "4. bash ${HelpJd} hangup   # 重启挂机程序"
  echo -e "5. bash ${HelpJd} resetpwd # 重置控制面板用户名和密码"
  echo -e "\n针对用法1、用法2中的\"xxx\"，可以不输入后缀\".js\"，另外，如果前缀是\"jd_\"的话前缀也可以省略。"
  echo -e "当前有以下脚本可以运行（仅列出以jd_、jr_、jx_开头的脚本）："
  cd ${ScriptsDir}
  for ((i=0; i<${#ListScripts[*]}; i++)); do
    Name=$(grep "new Env" ${ListScripts[i]} | awk -F "'|\"" '{print $2}')
    echo -e "$(($i + 1)).${Name}：${ListScripts[i]}"
  done
}

## nohup
function Run_Nohup {
  if [[ $(ps -ef | grep "${js}" | grep -v "grep") != "" ]]; then
    ps -ef | grep "${js}" | grep -v "grep" | awk '{print $2}' | xargs kill -9
  fi
  [ ! -d ${LogDir}/${js} ] && mkdir -p ${LogDir}/${js}
  LogTime=$(date "+%Y-%m-%d-%H-%M-%S")
  LogFile="${LogDir}/${js}/${LogTime}.log"
  nohup node ${js}.js > ${LogFile} &
}

## 运行挂机脚本
function Run_HangUp {
  HangUpJs="jd_crazy_joy_coin"
  cd ${ScriptsDir}
  for js in ${HangUpJs}; do
    Import_Conf ${js} && Set_Env
    if type pm2 >/dev/null 2>&1; then
      pm2 stop ${js}.js 2>/dev/null
      pm2 flush
      pm2 start -a ${js}.js --watch "${ScriptsDir}/${js}.js" --name="${js}"
    else
      Run_Nohup >/dev/null 2>&1
    fi
  done
}

## 重置密码
function Reset_Pwd {
  cp -f ${ShellDir}/sample/auth.json ${ConfigDir}/auth.json
  echo -e "控制面板重置成功，用户名：admin，密码：adminadmin\n"
}

## 一次性运行所有脚本
function Run_All {
  if [ ! -f ${ListJs} ]; then
    cat ${ListCronLxk} | grep -E "j[drx]_\w+\.js" | perl -pe "s|.+(j[drx]_\w+)\.js.+|\1|" | sort -u > ${ListJs}
  fi
  echo -e "\n==================== 开始运行所有非挂机脚本 ====================\n"
  echo -e "请注意：本过程将非常非常耗时，一个账号可能长达几小时，账号越多耗时越长，如果是手动运行，退出终端也将终止运行。\n"
  echo -e "倒计时5秒...\n"
  for ((sec=5; sec>0; sec--)); do
    echo -e "$sec...\n"
    sleep 1
  done
  for file in $(cat ${ListJs}); do
    echo -e "==================== 运行 $file.js 脚本 ====================\n"
    bash ${ShellJd} $file now
  done
}

## 正常运行单个脚本
function Run_Normal {
  Import_Conf $1 && Detect_Cron && Set_Env
  
  FileNameTmp1=$(echo $1 | perl -pe "s|\.js||")
  FileNameTmp2=$(echo $1 | perl -pe "{s|jd_||; s|\.js||; s|^|jd_|}")
  SeekDir="${ScriptsDir} ${ScriptsDir}/backUp ${ConfigDir}"
  FileName=""
  WhichDir=""

  for dir in ${SeekDir}
  do
    if [ -f ${dir}/${FileNameTmp1}.js ]; then
      FileName=${FileNameTmp1}
      WhichDir=${dir}
      break
    elif [ -f ${dir}/${FileNameTmp2}.js ]; then
      FileName=${FileNameTmp2}
      WhichDir=${dir}
      break
    fi
  done
  
  if [ -n "${FileName}" ] && [ -n "${WhichDir}" ]
  then
    [ $# -eq 1 ] && Random_Delay
    LogTime=$(date "+%Y-%m-%d-%H-%M-%S")
    LogFile="${LogDir}/${FileName}/${LogTime}.log"
    [ ! -d ${LogDir}/${FileName} ] && mkdir -p ${LogDir}/${FileName}
    cd ${WhichDir}
    node ${FileName}.js 2>&1 | tee ${LogFile}
  else
    echo -e "\n在${ScriptsDir}、${ScriptsDir}/backUp、${ConfigDir}三个目录下均未检测到 $1 脚本的存在，请确认...\n"
    Help
  fi
}

## 命令检测
case $# in
  0)
    echo
    Help
    ;;
  1)
    case $1 in
      hangup)
        Run_HangUp
        ;;
      resetpwd)
        Reset_Pwd
        ;;
      runall)
        Run_All
        ;;
      *)
        Run_Normal $1
        ;;
    esac
    ;;
  2)
    case $2 in
      now)
        Run_Normal $1 $2
        ;;
      *)
        echo -e "\n命令输入错误...\n"
        Help
        ;;
    esac
    ;;
  *)
    echo -e "\n命令过多...\n"
    Help
    ;;
esac
