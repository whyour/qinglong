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


## 运行 rmlog 命令时删除多久以前的日志，仅能输入正整数
RmLogDaysAgo="7"


## 在运行 task 或 mytask 命令时，随机延迟启动任务的最大延迟时间
## 如果任务不是必须准点运行的任务，那么给它增加一个随机延迟，由你定义最大延迟时间，单位为秒，如 RandomDelay="300" ，表示任务将在 1-300 秒内随机延迟一个秒数，然后再运行
## 在crontab.list中，在每小时第0-2分、第30-31分、第59分这几个时间内启动的任务，均算作必须准点运行的任务，在启动这些任务时，即使你定义了RandomDelay，也将准点运行，不启用随机延迟
## 在crontab.list中，除掉每小时上述时间启动的任务外，其他任务在你定义了 RandomDelay 的情况下，一律启用随机延迟，但如果你给某些任务添加了 "now" 或者 "conc"，那么这些任务也将无视随机延迟直接启动
RandomDelay="300"


## 如果你自己会写shell脚本，并且希望在每次运行 update 命令时，额外运行你的 shell 脚本，请赋值为 "true"
## 同时，请务必将你的脚本命名为 extra.sh (只能叫这个文件名)，放在 config 目录下
EnableExtraShell=""


## 启用其他开发者的仓库方式一（选填）：完整更新整个仓库，针对同一个仓库，方式一和方式二只能选择一种
## RepoUrl：仓库地址清单，必须从1开始依次编号
## RepoBranch：你想使用的分支清单，不指定分支（即使用默认分支）时可以用一对不包含内容的空引号""，编号必须和 OwnRepoUrl 对应。
## RepoPath：要使用的脚本在仓库哪个路径下，请输入仓库下的相对路径，默认空值""代表仓库根目录，编号必须和 OwnRepoUrl 对应，同一个仓库下不同文件夹之间使用空格分开。如果既包括根目录又包括子目录，填写请见示例中OwnRepoPath3。
## 所有脚本存放在 own 目录下，三个清单必须一一对应，示例如下：
## RepoUrl1="https://gitee.com/abc/jdtsa.git"
## RepoUrl2="https://github.com/nedcd/jxddfsa.git"
## RepoUrl3="git@github.com:eject/poex.git"
## 
## RepoBranch1=""         # 代表第1个仓库 https://gitee.com/abc/jdtsa.git 使用 "默认" 分支
## RepoBranch2="main"     # 代表第2个仓库 https://github.com/nedcd/jxddfsa.git 使用 "main" 分支
## RepoBranch3="master"   # 代表第3个仓库 git@github.com:eject/poex.git 使用 "master" 分支
## 
## RepoPath1=""                   # 代表第1个仓库https://gitee.com/abc/jdtsa.git，你想使用的脚本就在仓库根目录下。
## RepoPath2="scripts/jd normal"  # 代表第2个仓库https://github.com/nedcd/jxddfsa.git，你想使用的脚本在仓库的 scripts/jd 和 normal文件夹下，必须输入相对路径
## RepoPath3="'' cron"            # 代表第3个仓库git@github.com:eject/poex.git，你想使用的脚本在仓库的 根目录 和 cron 文件夹下，必须输入相对路径

RepoUrl1=""
RepoUrl2=""

RepoBranch1=""
RepoBranch2=""

RepoPath1=""
RepoPath2=""

## 启用其他开发者的仓库方式二（选填）：只下载想要的文件，针对同一个脚本，方式一和方式二建议只选择一种。
## 请先确认你能正常下载该raw文件才列在下方，无论是github还是gitee，请只填入 raw 文件链接。
## 一行一个文件下载链接，首尾一对半角括号，示例：
## RawUrl=(
##     https://gitee.com/wabdwdd/scipts/raw/master/jd_abc.js
##     https://github.com/lonfeg/loon/raw/main/jd_dudi.js
##     https://github.com/sunsem/qx/raw/main/z_dida.js
## )
RawUrl=(
    
)