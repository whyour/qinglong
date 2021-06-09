from telethon import events
from .. import jdbot, chat_id, _JdDir
from .utils import cmd, nodebtn


@jdbot.on(events.NewMessage(from_users=chat_id, pattern=r'^/snode'))
async def mysnode(event):
    '''定义supernode文件命令'''
    SENDER = event.sender_id
    path = _JdDir
    page = 0
    filelist = None
    async with jdbot.conversation(SENDER, timeout=60) as conv:
        msg = await conv.send_message('正在查询，请稍后')
        while path:
            path, msg, page, filelist = await nodebtn(conv, SENDER, path, msg, page, filelist)
    if filelist and filelist.startswith('CMD-->'):
        await cmd(filelist.replace('CMD-->', ''))
