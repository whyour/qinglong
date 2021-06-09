from telethon import TelegramClient
import json
import os
import logging

_JdDir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
_ConfigDir = _JdDir + '/config'
_ScriptsDir = _JdDir + '/scripts'
_OwnDir = _JdDir + '/own'
_JdbotDir = _JdDir + '/jbot'
_DiyScripts = _JdDir + '/diyscripts'
_LogDir = _JdDir + '/log'
_shortcut = _ConfigDir + '/shortcut.list'
_botlog = _LogDir + '/bot/run.log'
_botjson = _ConfigDir + '/bot.json'
img_file = _ConfigDir + 'qr.jpg'
if not os.path.exists(_LogDir + '/bot'):
    os.mkdir(_LogDir + '/bot')
logging.basicConfig(
    format='%(asctime)s-%(name)s-%(levelname)s=> [%(funcName)s] %(message)s ', level=logging.INFO, filename=_botlog,
    filemode='w')
logger = logging.getLogger(__name__)

with open(_botjson, 'r', encoding='utf-8') as f:
    bot = json.load(f)
chat_id = int(bot['user_id'])
# 机器人 TOKEN
TOKEN = bot['bot_token']
# HOSTAPI = bot['apihost']
# 发消息的TG代理
# my.telegram.org申请到的api_id,api_hash
api_id = bot['api_id']
api_hash = bot['api_hash']
proxystart = bot['proxy']
StartCMD = bot['StartCMD']
if 'proxy_user' in bot.keys() and bot['proxy_user'] != "代理的username,有则填写，无则不用动":
    proxy = {
        'proxy_type': bot['proxy_type'],
        'addr':  bot['proxy_add'],
        'port': bot['proxy_port'],
        'username': bot['proxy_user'],
        'password': bot['proxy_password']}
else:
    proxy = (bot['proxy_type'], bot['proxy_add'], bot['proxy_port'])
# 开启tg对话
if proxystart and 'noretry' in bot.keys() and bot['noretry']:
    jdbot = TelegramClient('bot', api_id, api_hash,
                           proxy=proxy).start(bot_token=TOKEN)
elif proxystart:
    jdbot = TelegramClient('bot', api_id, api_hash,
                           proxy=proxy, connection_retries=None).start(bot_token=TOKEN)
elif 'noretry' in bot.keys() and bot['noretry']:
    jdbot = TelegramClient('bot', api_id, api_hash).start(bot_token=TOKEN)
else:
    jdbot = TelegramClient('bot', api_id, api_hash,
                           connection_retries=None).start(bot_token=TOKEN)
