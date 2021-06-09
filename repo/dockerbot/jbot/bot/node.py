from telethon import events
import re
from .. import jdbot, chat_id
from .utils import cmd, jdcmd


@jdbot.on(events.NewMessage(from_users=chat_id, pattern='/node'))
async def mynode(event):
    '''接收/node命令后执行程序'''
    nodereg = re.compile(r'^/node [\S]+')
    text = re.findall(nodereg, event.raw_text)
    if len(text) == 0:
        res = '''请正确使用/node命令，如
        /node /abc/123.js 运行abc/123.js脚本
        /node /own/abc.js 运行own/abc.js脚本
        '''
        await jdbot.send_message(chat_id, res)
    else:
        await cmd('{} {} now'.format(jdcmd, text[0].replace('/node ', '')))
