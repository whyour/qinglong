from telethon import events, Button
import os
import shutil
from asyncio import exceptions
from .. import jdbot, chat_id, _JdDir
from .utils import split_list, logger,press_event


@jdbot.on(events.NewMessage(from_users=chat_id, pattern='/edit'))
async def myfileup(event):
    '''定义编辑文件操作'''
    SENDER = event.sender_id
    path = _JdDir
    page = 0
    if len(event.raw_text.split(' ')) > 1:
        text = event.raw_text.replace('/edit ','')
    else:
        text =None
    if text and os.path.isfile(text):
        try:
            with open(text,'r',encoding='utf-8') as f:
                lines = f.readlines()
                filelist = split_list(lines, 15)
                path = text
        except Exception as e:
            await jdbot.send_message(chat_id, 'something wrong,I\'m sorry\n'+str(e))
    elif text and os.path.isdir(text):
        path = text
        filelist = None
    elif text:
        await jdbot.send_message(chat_id, 'please marksure it\'s a dir or a file')
        filelist = None
    else:
        filelist = None
    async with jdbot.conversation(SENDER, timeout=60) as conv:
        msg = await conv.send_message('正在查询，请稍后')
        while path:
            path, msg, page, filelist = await myedit(conv, SENDER, path, msg, page, filelist)


async def myedit(conv, SENDER, path, msg, page, filelist):
    mybtn = [Button.inline('上一页', data='up'), Button.inline('下一页', data='next'), Button.inline(
        '上级', data='updir'), Button.inline('取消', data='cancel')]
    mybtn2 = [[Button.inline('上一页', data='up'), Button.inline(
        '下一页', data='next'), Button.inline('取消', data='cancel')], [Button.inline('上十页', data='up10'), Button.inline(
            '下十页', data='next10'), Button.inline('编辑', data='edit')]]
    try:
        if filelist and type(filelist[0][0]) == str:
            markup = filelist
            newmarkup = markup[page]
            msg = await jdbot.edit_message(msg, "".join(newmarkup), buttons=mybtn2)
        else:
            if filelist:
                markup = filelist
                newmarkup = markup[page]
                if mybtn not in newmarkup:
                    newmarkup.append(mybtn)
            else:
                dir = os.listdir(path)
                dir.sort()
                markup = [Button.inline(file, data=str(
                    file)) for file in dir]
                markup = split_list(markup, 3)
                if len(markup) > 30:
                    markup = split_list(markup, 30)
                    newmarkup = markup[page]
                    newmarkup.append(mybtn)
                else:
                    newmarkup = markup
                    if path == _JdDir:
                        newmarkup.append([Button.inline('取消', data='cancel')])
                    else:
                        newmarkup.append(
                            [Button.inline('上级', data='updir'), Button.inline('取消', data='cancel')])
            msg = await jdbot.edit_message(msg, '请做出您的选择：', buttons=newmarkup)
        convdata = await conv.wait_event(press_event(SENDER))
        res = bytes.decode(convdata.data)
        if res == 'cancel':
            msg = await jdbot.edit_message(msg, '对话已取消')
            conv.cancel()
            return None, None, None, None
        elif res == 'next':
            page = page + 1
            if page > len(markup) - 1:
                page = 0
            return path, msg, page,  markup
        elif res == 'up':
            page = page - 1
            if page < 0:
                page = len(markup) - 1
            return path, msg, page,  markup
        elif res == 'next10':
            page = page + 10
            if page > len(markup) - 1:
                page = 0
            return path, msg, page,  markup
        elif res == 'up10':
            page = page - 10
            if page < 0:
                page = len(markup) - 1
            return path, msg, page,  markup
        elif res == 'updir':
            path = '/'.join(path.split('/')[:-1])
            if path == '':
                path = _JdDir
            return path, msg, page,  None
        elif res == 'edit':
            await jdbot.send_message(chat_id, '请复制并修改以下内容，修改完成后发回机器人，2分钟内有效')
            await jdbot.delete_messages(chat_id, msg)
            msg = await conv.send_message("".join(newmarkup))
            resp = await conv.get_response()
            markup[page] = resp.raw_text.split('\n')
            for a in range(len(markup[page])):
                markup[page][a] = markup[page][a]+'\n'
            shutil.copy(path, path+'.bak')
            with open(path, 'w+', encoding='utf-8') as f:
                markup = ["".join(a) for a in markup]
                f.writelines(markup)
            await jdbot.send_message(chat_id, '文件已修改成功，原文件备份为'+path+'.bak')
            conv.cancel()
            return None, None, None, None
        elif os.path.isfile(path+'/'+res):
            msg = await jdbot.edit_message(msg, '文件读取中...请稍候')
            with open(path+'/'+res, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            lines = split_list(lines, 15)
            page = 0
            return path+'/'+res, msg, page, lines
        else:
            return path+'/'+res, msg, page, None
    except exceptions.TimeoutError:
        msg = await jdbot.edit_message(msg, '选择已超时，本次对话已停止')
        return None, None, None, None
    except Exception as e:
        msg = await jdbot.edit_message(msg, 'something wrong,I\'m sorry\n'+str(e))
        logger.error('something wrong,I\'m sorry\n'+str(e))
        return None, None, None, None
