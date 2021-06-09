#引入库文件，基于telethon
from telethon import events
#从上级目录引入 jdbot,chat_id变量
from .. import jdbot,chat_id
#格式基本固定，本例子表示从chat_id处接收到包含hello消息后，要做的事情
@jdbot.on(events.NewMessage(chats=chat_id,pattern=('hello')))
#定义自己的函数名称
async def hi(event):
    #do something
    await jdbot.send_message(chat_id,'hello')