#!/usr/bin/env bash

ShellDir=${QL_DIR:-$(
  cd $(dirname $0)
  pwd
)}
[[ $QL_DIR ]] && ShellJs=js
LogDir=$ShellDir/log
[ ! -d $LogDir ] && mkdir -p $LogDir
DbDir=$ShellDir/db
[ ! -d $DbDir ] && mkdir -p $DbDir
ManualLogDir=$ShellDir/manual_log
[ ! -d $ManualLogDir ] && mkdir -p $ManualLogDir
ScriptsDir=$ShellDir/scripts
ConfigDir=$ShellDir/config
FileConf=$ConfigDir/config.sh
CookieConf=$ConfigDir/cookie.sh
AuthConf=$ConfigDir/auth.json
ExtraShell=$ConfigDir/extra.sh
FileConfSample=$ShellDir/sample/config.sh.sample
ListCronSample=$ShellDir/sample/crontab.list.sample
ListCronCurrent=$ConfigDir/crontab.list
ListCronRemote=$ScriptsDir/docker/crontab_list.sh
ListCurrentTask=$LogDir/task.list
ListRemoteTask=$LogDir/js.list
ListJsAdd=$LogDir/js-add.list
ListJsDrop=$LogDir/js-drop.list
ContentVersion=$ShellDir/version
ContentNewTask=$ShellDir/new_task
ContentDropTask=$ShellDir/drop_task
SendVersion=$ShellDir/send_version
isTermux=$ANDROID_RUNTIME_ROOT$ANDROID_ROOT
ShellURL=https://ghproxy.com/https://github.com/whyour/qinglong
ScriptsURL=https://ghproxy.com/https://github.com/gossh520/jd_scripts

Import_Conf() {
  if [ ! -s $FileConf ]; then
    echo -e "复制一份 $FileConfSample 示例配置文件\n\n"
    cp -fv $FileConfSample $FileConf
  fi
  if [ ! -s $ListCronCurrent ]; then
    echo -e "复制一份 $ListCronSample 基础定时任务\n\n"
    cp -fv $ListCronSample $ListCronCurrent
  fi
  [ -f $CookieConf ] && . $CookieConf
  [ -f $FileConf ] && . $FileConf
}

# 更新shell
Git_Pull_Shell() {
  echo -e "更新shell...\n"
  cd $ShellDir
  git remote set-url origin $ShellURL
  git fetch --all
  ExitStatusShell=$?
  git reset --hard origin/master
  git pull
}

Git_Pull_Shell_Next() {
  if [[ $ExitStatusShell -eq 0 ]]; then
    echo -e "更新shell成功...\n"
    [ ! -d $ShellDir/node_modules ] && Npm_Install panel
    [ -f $ShellDir/package.json ] && PanelDependNew=$(cat $ShellDir/package.json)
    [[ "$PanelDependOld" != "$PanelDependNew" ]] && cd $ShellDir && Npm_Install panel
    cp -f $FileConfSample $ConfigDir/config.sh.sample
    Notify_Version
  else
    echo -e "更新shell失败，请检查原因...\n"
  fi
}

## npm install
Npm_Install() {
  echo -e "检测到 $1 的依赖包有变化，运行 npm install...\n"
  Npm_InstallSub
  if [ $? -ne 0 ]; then
    echo -e "\nnpm install 运行不成功，自动删除 $1/node_modules 后再次尝试一遍..."
    rm -rf node_modules
  fi
  echo

  if [ ! -d node_modules ]; then
    echo -e "运行 npm install...\n"
    Npm_InstallSub
    if [ $? -ne 0 ]; then
      echo -e "\nnpm install 运行不成功，自动删除 $1/node_modules...\n"
      echo -e "请进入 $1 目录后手动运行 npm install...\n"
      echo -e "3...\n"
      sleep 1
      echo -e "2...\n"
      sleep 1
      echo -e "1...\n"
      sleep 1
      rm -rf node_modules
    fi
  fi
}

## npm install 子程序，判断是否为安卓，判断是否安装有yarn
function Npm_InstallSub() {
  if [ -n "$isTermux" ]; then
    npm install --no-save --no-bin-links --registry=https://registry.npm.taobao.org || npm install --no-bin-links --no-save
  elif ! type yarn >/dev/null 2>&1; then
    npm install --no-save --registry=https://registry.npm.taobao.org || npm install --no-save
  else
    echo -e "检测到本机安装了 yarn，使用 yarn 替代 npm...\n"
    yarn install --registry=https://registry.npm.taobao.org --network-timeout 1000000000 || yarn install
  fi
}

## 检测配置文件版本
Notify_Version() {
  ## 识别出两个文件的版本号
  VerConfSample=$(grep " Version: " $FileConfSample | perl -pe "s|.+v((\d+\.?){3})|\1|")
  [ -f $FileConf ] && VerConf=$(grep " Version: " $FileConf | perl -pe "s|.+v((\d+\.?){3})|\1|")

  ## 删除旧的发送记录文件
  [ -f "$SendVersion" ] && [[ $(cat $SendVersion) != $VerConfSample ]] && rm -f $SendVersion

  ## 识别出更新日期和更新内容
  UpdateDate=$(grep " Date: " $FileConfSample | awk -F ": " '{print $2}')
  UpdateContent=$(grep " Update Content: " $FileConfSample | awk -F ": " '{print $2}')

  ## 如果是今天，并且版本号不一致，则发送通知
  if [ -f $FileConf ] && [[ "$VerConf" != "$VerConfSample" ]] && [[ $UpdateDate == $(date "+%Y-%m-%d") ]]; then
    if [ ! -f $SendVersion ]; then
      notify "检测到配置文件config.sh.sample有更新" "更新日期: $UpdateDate\n当前版本: $VerConf\n新的版本: $VerConfSample\n更新内容: $UpdateContent\n更新说明: 如需使用新功能请对照config.sh.sample，将相关新参数手动增加到你自己的config.sh中，否则请无视本消息。本消息只在该新版本配置文件更新当天发送一次。"
    fi
  else
    [ -f $ContentVersion ] && rm -f $ContentVersion
    [ -f $SendVersion ] && rm -f $SendVersion
  fi
}

## 每天次数随机，更新时间随机，更新秒数随机，至少6次，至多12次，大部分为8-10次，符合正态分布。
Random_Pull_Cron() {
  if [[ $(date "+%-H") -le 2 ]]; then
    RanMin=$(($RANDOM % 60))
    RanSleep=$(($RANDOM % 56))
    RanHourArray[0]=$(($RANDOM % 3))
    for ((i = 1; i < 14; i++)); do
      j=$(($i - 1))
      tmp=$(($RANDOM % 3 + ${RanHourArray[j]} + 2))
      [[ $tmp -lt 24 ]] && RanHourArray[i]=$tmp || break
    done

    RanHour=${RanHourArray[0]}
    for ((i = 1; i < ${#RanHourArray[*]}; i++)); do
      RanHour="$RanHour,${RanHourArray[i]}"
    done

    perl -i -pe "s|.+(git_pull? .+git_pull\.log.*)|$RanMin $RanHour \* \* \* sleep $RanSleep && \1|" $ListCronCurrent
    crontab $ListCronCurrent
  fi
}

## 克隆scripts
Git_Clone_Scripts() {
  git clone -b master $ScriptsURL $ScriptsDir
  ExitStatusScripts=$?
}

## 更新scripts
Git_Pull_Scripts() {
  if [ -d $ScriptsDir/.git ]; then
    echo -e "更新scripts...\n"
    cd $ScriptsDir
    git remote set-url origin $ScriptsURL
    git fetch --all
    ExitStatusScripts=$?
    git reset --hard origin/master
    git pull
  else
    Git_Clone_Scripts
  fi
}

Git_Pull_Scripts_Next() {
  if [[ $ExitStatusShell -eq 0 ]]; then
    echo -e "更新scripts成功...\n"
    [ ! -d $ScriptsDir/node_modules ] && Npm_Install scripts
    [ -f $ScriptsDir/package.json ] && ScriptsDependNew=$(cat $ScriptsDir/package.json)
    [[ "$ScriptsDependOld" != "$ScriptsDependNew" ]] && cd $ScriptsDir && Npm_Install scripts
    Diff_Cron
    if [ -s $ListJsDrop ]; then
      Output_ListJs $ListJsDrop "失效"
      Del_Cron
    fi
    if [ -s $ListJsAdd ]; then
      Output_ListJs $ListJsAdd "新"
      Add_Cron
    fi
  else
    echo -e "更新scripts失败，请检查原因...\n"
  fi
}

Diff_Cron() {
  cat $ListCronRemote | grep -E "node.+j[drx]_\w+\.js" | perl -pe "s|.+(j[drx]_\w+)\.js.+|\1|" | sort -u >$ListRemoteTask
  cat $ListCronCurrent | grep -E "$ShellJs j[drx]_\w+" | perl -pe "s|.*ID=(.*) $ShellJs (j[drx]_\w+)\.*|\2|" | sort -u >$ListCurrentTask
  if [ -s $ListCurrentTask ]; then
    grep -vwf $ListCurrentTask $ListRemoteTask >$ListJsAdd
  else
    cp -f $ListRemoteTask $ListJsAdd
  fi
  if [ -s $ListRemoteTask ]; then
    grep -vwf $ListRemoteTask $ListCurrentTask >$ListJsDrop
  else
    cp -f $ListCurrentTask $ListJsDrop
  fi
}

Del_Cron() {
  if [ $AutoDelCron == true ] && [ -s $ListJsDrop ]; then
    echo -e "开始尝试自动删除定时任务如下：\n"
    cat $ListJsDrop
    echo
    JsDrop=$(cat $ListJsDrop)
    for Cron in $JsDrop; do
      local id=$(cat $ListCronCurrent | grep -E "js $Cron" | perl -pe "s|.*ID=(.*) js $Cron|\1|")
      del_cron_api "$id"
    done
    crontab $ListCronCurrent
    echo -e "成功删除失效的脚本与定时任务\n"
    notify "删除 lxk0301 失效脚本" "$JsDrop"
  fi
}

Add_Cron() {
  if [ $AutoAddCron == true ] && [ -s $ListJsAdd ]; then
    echo -e "开始尝试自动添加定时任务\n"
    JsAdd=$(cat $ListJsAdd)
    for Cron in $JsAdd; do
      if [[ $Cron == jd_bean_sign ]]; then
        local name=$(cat "$ScriptsDir/$Cron.js" | grep -E "new Env\(" | perl -pe "s|(^.+)new Env\(\'*\"*(.+?)'*\"*\).+|\2|")
        add_cron_api "4 0,9 * * *" "$ShellJs $Cron" "$name"
      else
        local name=$(cat "$ScriptsDir/$Cron.js" | grep -E "new Env\(" | perl -pe "s|(^.+)new Env\(\'*\"*(.+?)'*\"*\).+|\2|")
        local param=$(cat $ListCronRemote | grep -E "\/$Cron\." | perl -pe "s|(^.+) node */scripts/(j[drx]_\w+)\.js.+|\1\:$ShellJs \2|")
        add_cron_api "$param:$name"
      fi
    done

    if [ $? -eq 0 ]; then
      crontab $ListCronCurrent
      echo -e "成功添加新的定时任务...\n"
      notify "新增lxk0301脚本" "$JsAdd"
    else
      echo -e "添加新的定时任务出错，请手动添加...\n"
      notify "尝试自动添加lxk0301以下新的定时任务出错，请手动添加：" "$JsAdd"
    fi
  fi
}

## 输出定时任务变化
Output_ListJs() {
  local list=$1
  local type=$2
  if [ -s $list ]; then
    echo -e "检测到有$type的定时任务：\n"
    cat $list
    echo
  fi
}

#################################################################################################################################
echo -e "\n--------------------------------------------------------------\n"
echo -n "系统时间："
echo $(date "+%Y-%m-%d %H:%M:%S")
if [ "${TZ}" = "UTC" ]; then
  echo -n "北京时间："
  echo $(date -d "8 hour" "+%Y-%m-%d %H:%M:%S")
fi
echo -e "\nJS脚本目录：$ScriptsDir\n"
echo -e "--------------------------------------------------------------\n"

. $ShellDir/shell/api.sh
get_token

Import_Conf

# 更新shell
[ -f $ShellDir/package.json ] && PanelDependOld=$(cat $ShellDir/package.json)
Git_Pull_Shell
Git_Pull_Shell_Next

## 更新scripts
[ -f $ScriptsDir/package.json ] && ScriptsDependOld=$(cat $ScriptsDir/package.json)
Git_Pull_Scripts
Git_Pull_Scripts_Next

## 调用用户自定义的extra.sh
if [[ $EnableExtraShell == true ]]; then
  if [ -f $ExtraShell ]; then
    . $ExtraShell
  else
    echo -e "$ExtraShell 文件不存在，跳过执行DIY脚本...\n"
  fi
fi
