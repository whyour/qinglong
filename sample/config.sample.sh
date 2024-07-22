## 在运行 ql repo 命令时，是否自动删除失效的脚本与定时任务
AutoDelCron="true"

## 在运行 ql repo 命令时，是否自动增加新的本地定时任务
AutoAddCron="true"

## 拉取脚本时默认的定时规则，当匹配不到定时规则时使用，例如: 0 9 * * *
DefaultCronRule=""

## ql repo命令拉取脚本时需要拉取的文件后缀，直接写文件后缀名即可
RepoFileExtensions="js mjs py pyc"

## 代理地址，支持HTTP/SOCK5，例如 http://127.0.0.1:7890
ProxyUrl=""

## 资源告警阙值，默认CPU 80%、内存80%、磁盘90%
CpuWarn=80
MemoryWarn=80
DiskWarn=90

## 设置定时任务执行的超时时间，例如1h，后缀"s"代表秒(默认值), "m"代表分, "h"代表小时, "d"代表天
CommandTimeoutTime=""

## 在运行 task 命令时，随机延迟启动任务的最大延迟时间，如 RandomDelay="300" ，表示任务将在 1-300 秒内随机延迟一个秒数，然后再运行，取消延迟赋值为空
RandomDelay=""

## 需要随机延迟运行任务的文件后缀，直接写后缀名即可，多个后缀用空格分开，例如: js py ts
## 默认仅给javascript任务加随机延迟，其它任务按定时规则准点运行。全部任务随机延迟赋值为空
RandomDelayFileExtensions=""

## 每小时的第几分钟准点运行任务，当在这些时间运行任务时将忽略 RandomDelay 配置，不会被随机延迟
## 默认是第0分钟和第30分钟，例如21:00或21:30分的任务将会准点运行。不需要准点运行赋值为空
RandomDelayIgnoredMinutes=""

## 如果你自己会写shell脚本，并且希望在每次容器启动时，额外运行你的 shell 脚本，请赋值为 "true"
EnableExtraShell=""

## 是否自动启动bot，默认不启动，设置为true时自动启动，目前需要自行克隆bot仓库所需代码，存到ql/repo目录下，文件夹命名为dockerbot
AutoStartBot=""

## 是否使用第三方bot，默认不使用，使用时填入仓库地址，存到ql/repo目录下，文件夹命名为diybot
BotRepoUrl=""

## 通知环境变量
## 1. Server酱
## https://sct.ftqq.com/r/13363
## 下方填写 SCHKEY 值或 SendKey 值
export PUSH_KEY=""

## 2. BARK
## 下方填写app提供的设备码，例如：https://api.day.app/123 那么此处的设备码就是123
export BARK_PUSH=""
## 下方填写推送图标设置，自定义推送图标(需iOS15或以上)
export BARK_ICON="https://qn.whyour.cn/logo.png"
## 下方填写推送声音设置，例如choo，具体值请在bark-推送铃声-查看所有铃声
export BARK_SOUND=""
## 下方填写推送消息分组，默认为"QingLong"
export BARK_GROUP="QingLong"
## bark 推送时效性
export BARK_LEVEL="active"
## bark 推送是否存档
export BARK_ARCHIVE=""
## bark 推送跳转 URL
export BARK_URL=""

## 3. Telegram
## 下方填写自己申请@BotFather的Token，如10xxx4:AAFcqxxxxgER5uw
export TG_BOT_TOKEN=""
## 下方填写 @getuseridbot 中获取到的纯数字ID
export TG_USER_ID=""
## Telegram 代理IP（选填）
## 下方填写代理IP地址，代理类型为 http，比如您代理是 http://127.0.0.1:1080，则填写 "127.0.0.1"
## 如需使用，请自行解除下一行的注释
export TG_PROXY_HOST=""
## Telegram 代理端口（选填）
## 下方填写代理端口号，代理类型为 http，比如您代理是 http://127.0.0.1:1080，则填写 "1080"
## 如需使用，请自行解除下一行的注释
export TG_PROXY_PORT=""
## Telegram 代理的认证参数（选填）
export TG_PROXY_AUTH=""
## Telegram api自建反向代理地址（选填）
## 教程：https://www.hostloc.com/thread-805441-1-1.html
## 如反向代理地址 http://aaa.bbb.ccc 则填写 aaa.bbb.ccc
## 如需使用，请赋值代理地址链接，并自行解除下一行的注释
export TG_API_HOST=""

## 4. 钉钉
## 官方文档：https://developers.dingtalk.com/document/app/custom-robot-access
## 下方填写token后面的内容，只需 https://oapi.dingtalk.com/robot/send?access_token=XXX 等于=符号后面的XXX即可
export DD_BOT_TOKEN=""
export DD_BOT_SECRET=""

## 企业微信反向代理地址
## (环境变量名 QYWX_ORIGIN)
export QYWX_ORIGIN=""

## 5. 企业微信机器人
## 官方说明文档：https://work.weixin.qq.com/api/doc/90000/90136/91770
## 下方填写密钥，企业微信推送 webhook 后面的 key
export QYWX_KEY=""

## 6. 企业微信应用
## 参考文档：http://note.youdao.com/s/HMiudGkb
## 下方填写素材库图片id（corpid,corpsecret,touser,agentid），素材库图片填0为图文消息, 填1为纯文本消息
export QYWX_AM=""

## 7. iGot聚合
## 参考文档：https://wahao.github.io/Bark-MP-helper
## 下方填写iGot的推送key，支持多方式推送，确保消息可达
export IGOT_PUSH_KEY=""

## 8. Push Plus
## 官方网站：http://www.pushplus.plus
## 下方填写您的Token，微信扫码登录后一对一推送或一对多推送下面的token，只填 PUSH_PLUS_TOKEN 默认为一对一推送
export PUSH_PLUS_TOKEN=""
## 一对一多推送（选填）
## 下方填写您的一对多推送的 "群组编码" ，（一对多推送下面->您的群组(如无则新建)->群组编码）
## 1. 需订阅者扫描二维码 2、如果您是创建群组所属人，也需点击“查看二维码”扫描绑定，否则不能接受群组消息推送
export PUSH_PLUS_USER=""

## 9. 微加机器人
## 官方网站：http://www.weplusbot.com
## 下方填写您的Token；微信扫描登录后在"我的"->"设置"->"令牌"中获取
export WE_PLUS_BOT_TOKEN=""
## 消息接收人；
## 个人版填写接收消息的群编码，不填发送给自己的微信号
## 专业版不填默认发给机器人自己，发送给好友填写wxid，发送给微信群填写群编码
export WE_PLUS_BOT_RECEIVER=""
## 调用版本；分为专业版和个人版，专业版填写pro，个人版填写personal
export WE_PLUS_BOT_VERSION="pro"

## 10. go-cqhttp
## gobot_url 推送到个人QQ: http://127.0.0.1/send_private_msg  群：http://127.0.0.1/send_group_msg
## gobot_token 填写在go-cqhttp文件设置的访问密钥
## gobot_qq 如果GOBOT_URL设置 /send_private_msg 则需要填入 user_id=个人QQ 相反如果是 /send_group_msg 则需要填入 group_id=QQ群
## go-cqhttp相关API https://docs.go-cqhttp.org/api
export GOBOT_URL=""
export GOBOT_TOKEN=""
export GOBOT_QQ=""

## 11. gotify
## gotify_url 填写gotify地址,如https://push.example.de:8080
## gotify_token 填写gotify的消息应用token
## gotify_priority 填写推送消息优先级,默认为0
export GOTIFY_URL=""
export GOTIFY_TOKEN=""
export GOTIFY_PRIORITY=0

## 12. PushDeer
## deer_key 填写PushDeer的key
export DEER_KEY=""

## 13. Chat
## chat_url 填写synology chat地址，http://IP:PORT/webapi/***token=
## chat_token 填写后面的token
export CHAT_URL=""
export CHAT_TOKEN=""

## 14. aibotk
## 官方说明文档：http://wechat.aibotk.com/oapi/oapi?from=ql
## aibotk_key (必填)填写智能微秘书个人中心的apikey
export AIBOTK_KEY=""
## aibotk_type (必填)填写发送的目标 room 或 contact, 填其他的不生效
export AIBOTK_TYPE=""
## aibotk_name (必填)填写群名或用户昵称，和上面的type类型要对应
export AIBOTK_NAME=""

## 15. CHRONOCAT
## CHRONOCAT_URL 推送 http://127.0.0.1:16530
## CHRONOCAT_TOKEN 填写在CHRONOCAT文件生成的访问密钥
## CHRONOCAT_QQ 个人:user_id=个人QQ 群则填入group_id=QQ群 多个用英文;隔开同时支持个人和群 如：user_id=xxx;group_id=xxxx;group_id=xxxxx
## CHRONOCAT相关API https://chronocat.vercel.app/install/docker/official/
export CHRONOCAT_URL=""
export CHRONOCAT_QQ=""
export CHRONOCAT_TOKEN=""

## 16. SMTP
## 邮箱服务名称，比如126、163、Gmail、QQ等，支持列表 https://github.com/nodemailer/nodemailer/blob/master/lib/well-known/services.json
export SMTP_SERVICE=""
## smtp_email 填写 SMTP 收发件邮箱，通知将会由自己发给自己
export SMTP_EMAIL=""
## smtp_password 填写 SMTP 登录密码，也可能为特殊口令，视具体邮件服务商说明而定
export SMTP_PASSWORD=""
## smtp_name 填写 SMTP 收发件人姓名，可随意填写
export SMTP_NAME=""

## 17. PushMe
## 官方说明文档：https://push.i-i.me/
## PUSHME_KEY (必填)填写PushMe APP上获取的push_key
## PUSHME_URL (选填)填写自建的PushMeServer消息服务接口地址，例如：http://127.0.0.1:3010，不填则使用官方接口服务
export PUSHME_KEY=""
export PUSHME_URL=""

## 18. 飞书机器人
## 官方文档：https://www.feishu.cn/hc/zh-CN/articles/360024984973
## FSKEY 飞书机器人的 FSKEY
export FSKEY=""

## 19. Qmsg酱
## 官方文档：https://qmsg.zendee.cn/docs/api/
## qmsg 酱的 QMSG_KEY
## qmsg 酱的 QMSG_TYPE send 为私聊，group 为群聊
export QMSG_KEY=""
export QMSG_TYPE=""

## 20. 自定义通知
## 自定义通知 接收回调的URL
export WEBHOOK_URL=""
## WEBHOOK_BODY 和 WEBHOOK_HEADERS 多个参数时，直接换行或者使用 $'\n' 连接多行字符串，比如 export dd="line 1"$'\n'"line 2"
export WEBHOOK_BODY=""
export WEBHOOK_HEADERS=""
## 支持 GET/POST/PUT
export WEBHOOK_METHOD=""
## 支持 text/plain、application/json、multipart/form-data、application/x-www-form-urlencoded
export WEBHOOK_CONTENT_TYPE=""

## 其他需要的变量，脚本中需要的变量使用 export 变量名= 声明即可
