from telethon import events
from .. import jdbot, chat_id, _shortcut


@jdbot.on(events.NewMessage(from_users=chat_id, pattern=r'^/setshort$'))
async def setshortcut(event):
    SENDER = event.sender_id
    async with jdbot.conversation(SENDER, timeout=60) as conv:
        await conv.send_message(
            '60s内回复有效\n请按格式输入您的快捷命令。例如：\n京豆通知-->jtask jd_bean_change\n更新脚本-->jup\n获取互助码-->jcode\nnode运行XX脚本-->node /XX/XX.js\nbash运行abc/123.sh脚本-->bash /abc/123.sh\n-->前边为要显示的名字，-->后边为要运行的命令\n 如添加运行脚本立即执行命令记得在后边添加now\n如不等待运行结果请添加nohup，如京豆通知-->nohup jtask jd_bean_change now\n如不添加nohup 会等待程序执行完，期间不能交互\n建议运行时间短命令不添加nohup\n部分功能青龙可能不支持，请自行测试，自行设定 ')
        shortcut = await conv.get_response()
        with open(_shortcut, 'w+', encoding='utf-8') as f:
            f.write(shortcut.raw_text)
        await conv.send_message('已设置成功可通过"/a"使用')
        conv.cancel()
