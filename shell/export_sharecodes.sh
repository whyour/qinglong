#!/usr/bin/env bash

## 路径、环境判断
ShellDir=${JD_DIR:-$(cd $(dirname $0); pwd)}
LogDir=${ShellDir}/log
ConfigDir=${ShellDir}/config
FileConf=${ConfigDir}/config.sh
[[ ${ANDROID_RUNTIME_ROOT}${ANDROID_ROOT} ]] && Opt="P" || Opt="E"
Tips="从日志中未找到任何互助码"

## 所有有互助码的活动，只需要把脚本名称去掉前缀 jd_ 后列在 Name1 中，将其中文名称列在 Name2 中，对应 config.sh 中互助码后缀列在 Name3 中即可。
## Name1、Name2 和 Name3 中的三个名称必须一一对应。
Name1=(fruit pet plantBean dreamFactory jdfactory crazy_joy jdzz jxnc bookshop cash sgmh cfd global)
Name2=(东东农场 东东萌宠 京东种豆得豆 京喜工厂 东东工厂 crazyJoy任务 京东赚赚 京喜农场 口袋书店 签到领现金 闪购盲盒 京喜财富岛 环球挑战赛)
Name3=(Fruit Pet Bean DreamFactory JdFactory Joy Jdzz Jxnc BookShop Cash Sgmh Cfd Global)


## 导入 config.sh
function Import_Conf {
  if [ -f ${FileConf} ]
  then
    . ${FileConf}
    if [ -z "${Cookie1}" ]; then
      echo -e "请先在 config.sh 中配置好 Cookie\n"
      exit 1
    fi
  else
    echo -e "配置文件 ${FileConf} 不存在，请先按教程配置好该文件\n"
    exit 1
  fi
}


## 用户数量 UserSum
function Count_UserSum {
  for ((i=1; i<=1000; i++)); do
    Tmp=Cookie$i
    CookieTmp=${!Tmp}
    [[ ${CookieTmp} ]] && UserSum=$i || break
  done
}


## 导出互助码的通用程序
function Cat_Scodes {
  if [ -d ${LogDir}/jd_$1 ] && [[ $(ls ${LogDir}/jd_$1) != "" ]]; then
    cd ${LogDir}/jd_$1
    
    ## 导出助力码变量（My）
    for log in $(ls -r); do
      case $# in
        2)
          codes=$(cat ${log} | grep -${Opt} "开始【京东账号|您的(好友)?助力码为" | uniq | perl -0777 -pe "{s|\*||g; s|开始||g; s|\n您的(好友)?助力码为(：)?:?|：|g; s|，.+||g}" | sed -r "s/【京东账号/My$2/;s/】.*?：/='/;s/】.*?/='/;s/$/'/;s/\(每次运行都变化,不影响\)//")
          ;;
        3)
          codes=$(grep -${Opt} $3 ${log} | uniq | sed -r "s/【京东账号/My$2/;s/（.*?】/='/;s/$/'/")
          ;;
      esac
      if [[ ${codes} ]]; then
        ## 添加判断，若未找到该用户互助码，则设置为空值
        for ((user_num=1;user_num<=${UserSum};user_num++)); do
          echo -e "${codes}" | grep -${Opt}q "My$2${user_num}="
          if [ $? -eq 1 ]; then
            if [ $user_num == 1 ]; then
              codes=$(echo "${codes}" | sed -r "1i My${2}1=''")
            else
              codes=$(echo "${codes}" | sed -r "/My$2$(expr ${user_num} - 1)=/a\My$2${user_num}=''")
            fi
          fi
        done
        break
      fi
    done

    ## 导出为他人助力变量（ForOther）
    if [[ ${codes} ]]; then
      help_code=""
      for ((user_num=1;user_num<=${UserSum};user_num++)); do
        echo -e "${codes}" | grep -${Opt}q "My$2${user_num}=''"
        if [ $? -eq 1 ]; then
          help_code=${help_code}"\${My"$2${user_num}"}@"
        fi
      done
      ## 生成互助规则模板
      for_other_codes=""
      case $HelpType in
        0) ### 统一优先级助力模板
          new_code=$(echo ${help_code} | sed "s/@$//")
          for ((user_num=1;user_num<=${UserSum};user_num++)); do
            if [ $user_num == 1 ]; then
              for_other_codes=${for_other_codes}"ForOther"$2${user_num}"=\""${new_code}"\"\n"
            else
              for_other_codes=${for_other_codes}"ForOther"$2${user_num}"=\"\${ForOther"${2}1"}\"\n"
            fi
          done
          ;;
        1) ### 均匀助力模板
          for ((user_num=1;user_num<=${UserSum};user_num++)); do
            echo ${help_code} | grep "\${My"$2${user_num}"}@" > /dev/null
            if [ $? -eq 0 ]; then
              left_str=$(echo ${help_code} | sed "s/\${My$2${user_num}}@/ /g" | awk '{print $1}')
              right_str=$(echo ${help_code} | sed "s/\${My$2${user_num}}@/ /g" | awk '{print $2}')
              mark="\${My$2${user_num}}@"
            else
              left_str=$(echo ${help_code} | sed "s/${mark}/ /g" | awk '{print $1}')${mark}
              right_str=$(echo ${help_code} | sed "s/${mark}/ /g" | awk '{print $2}')
            fi
            new_code=$(echo ${right_str}${left_str} | sed "s/@$//")
            for_other_codes=${for_other_codes}"ForOther"$2${user_num}"=\""${new_code}"\"\n"
          done
          ;;
        *) ### 普通优先级助力模板
          for ((user_num=1;user_num<=${UserSum};user_num++)); do
            new_code=$(echo ${help_code} | sed "s/\${My"$2${user_num}"}@//;s/@$//")
            for_other_codes=${for_other_codes}"ForOther"$2${user_num}"=\""${new_code}"\"\n"
          done
          ;;
      esac
      echo -e "${codes}\n\n${for_other_codes}" | sed s/[[:space:]]//g
    else
      echo ${Tips}
    fi
  else
    echo "未运行过 jd_$1 脚本，未产生日志"
  fi
}


## 汇总
function Cat_All {
  echo -e "\n从最后一个日志提取互助码，受日志内容影响，仅供参考。"
  for ((i=0; i<${#Name1[*]}; i++)); do
    echo -e "\n${Name2[i]}："
    [[ $(Cat_Scodes "${Name1[i]}" "${Name3[i]}" "的${Name2[i]}好友互助码") == ${Tips} ]] && Cat_Scodes "${Name1[i]}" "${Name3[i]}" || Cat_Scodes "${Name1[i]}" "${Name3[i]}" "的${Name2[i]}好友互助码"
  done
}


## 执行并写入日志
LogTime=$(date "+%Y-%m-%d-%H-%M-%S")
LogFile="${LogDir}/export_sharecodes/${LogTime}.log"
[ ! -d "${LogDir}/export_sharecodes" ] && mkdir -p ${LogDir}/export_sharecodes
Import_Conf && Count_UserSum && Cat_All | perl -pe "{s|京东种豆|种豆|; s|crazyJoy任务|疯狂的JOY|}" | tee ${LogFile}
