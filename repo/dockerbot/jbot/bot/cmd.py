from telethon import events
import re
from .. import jdbot, StartCMD, chat_id, logger
from .utils import cmd


@jdbot.on(events.NewMessage(from_users=chat_id, pattern='/cmd'))
async def mycmd(event):
    '''接收/cmd命令后执行程序'''
    if StartCMD:
        cmdreg = re.compile(r'^/cmd [\s\S]+')
        text = re.findall(cmdreg, event.raw_text)
        if len(text) == 0:
            msg = '''请正确使用/cmd命令，如
            /cmd jlog    # 删除旧日志
            /cmd jup     # 更新所有脚本
            /cmd jcode   # 导出所有互助码
            /cmd jcsv    # 记录豆豆变化情况
            不建议直接使用cmd命令执行脚本，请使用/node或/snode
            '''
            await jdbot.send_message(chat_id, msg)
        else:
            logger.info(text)
            await cmd(text[0].replace('/cmd ', ''))
    else:
        await jdbot.send_message(chat_id, '未开启CMD命令，如需使用请修改配置文件')
