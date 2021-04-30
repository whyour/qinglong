## Version: v2.0.0
## Date: 2021-04-07
## Update Content: 新一版qinglong。

## 上面版本号中，如果第2位数字有变化，那么代表增加了新的参数，如果只有第3位数字有变化，仅代表更新了注释，没有增加新的参数，可更新可不更新


## 临时屏蔽某个Cookie
## 多个Cookie编号以半角的空格分隔，两侧一对半角双引号，使用此功能后，在运行脚本时账户编号将发生变化
## 举例1：TempBlockCookie="2"    临时屏蔽掉Cookie2
## 举例2：TempBlockCookie="2 4"  临时屏蔽掉Cookie2和Cookie4
TempBlockCookie=""

## 如果只是想要屏蔽某个账号不跑某一些脚本，可以参考下面 case 这个命令的例子来控制，case的条件中请输入脚本从scripts目录出发的相对路径，也就是在crontab.list中的task命令后面的脚本路径是什么，这里就填入什么
## case $1 in
##     lxk0301_jd_scripts/jd_fruit.js)
##         TempBlockCookie="5"      # 账号5不玩lxk0301_jd_scripts下的jd_fruit.js
##         ;;
##     lxk0301_jd_scripts/jd_dreamFactory.js | whyour_hundun/quanx/didi.js)
##         TempBlockCookie="2"      # 账号2不玩lxk0301_jd_scripts下的jd_dreamFactory.js和whyour_hundun下子文件夹quanx中的didi.js
##         ;;
##     lxk0301_jd_scripts/jd_jdzz.js | whyour_hundun/quanx/jx_factory.js)
##         TempBlockCookie="3 6"    # 账号3、账号6不玩lxk0301_jd_scripts下的jd_jdzz.js和whyour_hundun下子文件夹quanx中的jx_factory.js
##         ;;
## esac


## 在运行 update 命令时，是否自动删除失效的脚本与定时任务
AutoDelCron="true"


## 在运行 update 命令时，是否自动增加新的本地定时任务
AutoAddCron="true"

## 在运行 task 命令时，随机延迟启动任务的最大延迟时间
## 如果任务不是必须准点运行的任务，那么给它增加一个随机延迟，由你定义最大延迟时间，单位为秒，如 RandomDelay="300" ，表示任务将在 1-300 秒内随机延迟一个秒数，然后再运行
## 在crontab.list中，在每小时第0-2分、第30-31分、第59分这几个时间内启动的任务，均算作必须准点运行的任务，在启动这些任务时，即使你定义了RandomDelay，也将准点运行，不启用随机延迟
## 在crontab.list中，除掉每小时上述时间启动的任务外，其他任务在你定义了 RandomDelay 的情况下，一律启用随机延迟，但如果你给某些任务添加了 "now" 或者 "conc"，那么这些任务也将无视随机延迟直接启动
RandomDelay="300"


## 如果你自己会写shell脚本，并且希望在每次运行 update 命令时，额外运行你的 shell 脚本，请赋值为 "true"
## 同时，请务必将你的脚本命名为 extra.sh (只能叫这个文件名)，放在 config 目录下
EnableExtraShell=""
