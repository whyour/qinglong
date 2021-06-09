#!/usr/bin/env python3
# _*_ coding:utf-8 _*_
# 0.3 版本开始不再区分ql、V3、V4。运行日志：log/bot/run.log
# author：   https://github.com/SuMaiKaDe

from . import jdbot, chat_id, logger,_JdbotDir, _LogDir
from .utils import load_diy
import os
from .bot.update import version,botlog
_botuplog = _LogDir + '/bot/up.log'
botpath = _JdbotDir + "/bot/"
diypath = _JdbotDir + "/diy/"
logger.info('loading bot module...')
load_diy('bot', botpath)
logger.info('loading diy module...')
load_diy('diy', diypath)

async def hello():
    if os.path.exists(_botuplog):
        isnew = False
        with open(_botuplog, 'r', encoding='utf-8') as f:
            logs = f.readlines()
        for log in logs:
            if version in log:
                isnew = True
                return
        if not isnew:
            with open(_botuplog, 'a', encoding='utf-8') as f:
                f.writelines([version, botlog])
            await jdbot.send_message(chat_id, '[机器人上新了](https://github.com/SuMaiKaDe/jddockerbot/tree/master)\n'+botlog+'\n运行日志为log/bot/run.log', link_preview=False)
    else:
        with open(_botuplog, 'w+', encoding='utf-8') as f:
            f.writelines([version, botlog])
        await jdbot.send_message(chat_id, '[机器人上新了](https://github.com/SuMaiKaDe/jddockerbot/tree/master)\n'+botlog+'\n运行日志为log/bot/run.log', link_preview=False)
if __name__ == "__main__":
    with jdbot:
        jdbot.loop.create_task(hello())
        jdbot.loop.run_forever()
