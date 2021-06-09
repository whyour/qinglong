from telethon import events
from .. import jdbot, chat_id


@jdbot.on(events.NewMessage(from_users=chat_id, pattern='/start'))
async def mystart(event):
    '''接收/start命令后执行程序'''
    msg = '''使用方法如下：
    /help 获取命令，可直接发送至botfather
    /a 使用你的自定义快捷按钮
    /start 开始使用本程序
    /node 执行js脚本文件，直接输入/node jd_bean_change 如执行其他自己js，需输入绝对路径。即可进行执行。该命令会等待脚本执行完，期间不能使用机器人，建议使用snode命令。
    /cmd 执行cmd命令,例如/cmd python3 /python/bot.py 则将执行python目录下的bot.py 不建议使用机器人使用并发，可能产生不明原因的崩溃
    /snode 命令可以选择脚本执行，只能选择/scripts 和/own目录下的脚本，选择完后直接后台运行，不影响机器人响应其他命令
    /log 选择查看执行日志
    /getfile 获取jd目录下文件
    /setshort 设置自定义按钮，每次设置会覆盖原设置
    /getcookie 扫码获取cookie 增加30s内取消按钮，30s后不能进行其他交互直到2分钟或获取到cookie
    /edit 从jd目录下选择文件编辑，需要将编辑好信息全部发给机器人，机器人会根据你发的信息进行替换。建议用来编辑config或crontab.list 其他文件慎用！！！
    此外直接发送文件，会让您选择保存到哪个文件夹，如果选择运行，将保存至own目录下，并立即运行脚本，crontab.list文件会自动更新时间'''
    await jdbot.send_message(chat_id, msg)
