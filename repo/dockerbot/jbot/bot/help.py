from telethon import events
from .. import jdbot, chat_id


@jdbot.on(events.NewMessage(from_users=chat_id, pattern='^/help'))
async def myhelp(event):
    '''接收/help命令后执行程序'''
    if len(event.raw_text) > 6:
        text = event.raw_text.replace('/help ', '')
    else:
        text = 'mhelp'
    mhelp = '''
a-我的自定义快捷按钮
bean-获取收支
edit-编辑文件
start-开始使用本程序
node-执行js脚本文件，绝对路径。
cmd-执行cmd命令
snode-选择脚本后台运行
log-选择日志
getfile-获取jd目录下文件
setshort-设置自定义按钮
getcookie-扫码获取cookie'''
    bean = '/bean 加数字，获取该账户近期收支情况\n/bean in\out获取所有账户近期收或支情况\n/bean 获取账户总豆数量'
    cmd = '/cmd用于执行cmd命令，如果命令持续10分钟仍未结束，将强行终止，以保障机器人响应'
    edit = '/edit 进入/jd目录选择文件进行编辑，仅限简易编辑\n/edit /jd/config进入config目录选择文件编辑\n/edit /jd/config/config.sh 直接编辑config.sh文件'
    getcookie = '/getcookie 扫码获取jdcookie'
    node = '/node 用于执行js脚本 用法：\n/node /jd/own/abc/def.js'
    getfile = '/getfile 进入/jd目录选择文件进行获取\n/getfile /jd/config进入config目录选择文件获取\n/getfile /jd/config/config.sh 直接获取config.sh文件'
    setshort = '/setshort 用于设置快捷方式，格式如下：\n更新-->jup\nAAA-->BBB这种格式使用/a选择\n/bean 1\n/edit /jd/config/config.sh\n以“/”开头的为机器人命令快捷，使用/b选择'
    snode = '/snode 选择脚本并运行'
    chart = ''
    helpme = {'bean': bean, 'cmd': cmd, 'edit': edit, 'getcookie': getcookie, 'node': node,
              'getfile': getfile, 'setshort': setshort, 'snode': snode, 'chart': chart,'mhelp':mhelp}
    await jdbot.send_message(chat_id, helpme[text])
