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
ShellURL=https://github.com.cnpmjs.org/whyour/qinglong
ScriptsURL=https://github.com.cnpmjs.org/gossh520/jd_scripts