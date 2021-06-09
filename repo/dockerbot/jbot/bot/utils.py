import os
from telethon import events, Button
import re
from .. import jdbot, chat_id, _LogDir, logger, _JdDir, _OwnDir, _ConfigDir
import asyncio
import datetime

bean_log = _LogDir + '/jd_bean_change/'
_ConfigFile = _ConfigDir+'/config.sh'
V4, QL = False, False
if 'JD_DIR' in os.environ.keys():
    V4 = True
    _ConfigFile = _ConfigDir+'/config.sh'
    _DiyDir = _OwnDir
    jdcmd = 'jtask'
elif 'QL_DIR' in os.environ.keys():
    QL = True
    _ConfigFile = _ConfigDir+'/cookie.sh'
    _DiyDir = None
    jdcmd = 'task'
    dirs = os.listdir(_LogDir)
    for mydir in dirs:
        if 'jd_bean_change' in mydir:
            bean_log = _LogDir + '/' + mydir
            break
else:
    _DiyDir = None
    jdcmd = 'node'

ckreg = re.compile(r'pt_key=\S*;pt_pin=\S*;')
with open(_ConfigFile, 'r', encoding='utf-8') as f:
    lines = f.read()
cookies = ckreg.findall(lines)
for ck in cookies:
    if ck == 'pt_key=xxxxxxxxxx;pt_pin=xxxx;':
        cookies.remove(ck)
        break


def split_list(datas, n, row: bool = True):
    """一维列表转二维列表，根据N不同，生成不同级别的列表"""
    length = len(datas)
    size = length / n + 1 if length % n else length/n
    _datas = []
    if not row:
        size, n = n, size
    for i in range(int(size)):
        start = int(i * n)
        end = int((i + 1) * n)
        _datas.append(datas[start:end])
    return _datas


async def backfile(file):
    '''如果文件存在，则备份，并更新'''
    if os.path.exists(file):
        try:
            os.rename(file, file+'.bak')
        except WindowsError:
            os.remove(file+'.bak')
            os.rename(file, file+'.bak')


def press_event(user_id):
    return events.CallbackQuery(func=lambda e: e.sender_id == user_id)


async def cmd(cmdtext):
    '''定义执行cmd命令'''
    try:
        msg = await jdbot.send_message(chat_id, '开始执行命令')
        p = await asyncio.create_subprocess_shell(
            cmdtext, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        res_bytes, res_err = await p.communicate()
        res = res_bytes.decode('utf-8')
        if len(res) == 0:
            await jdbot.edit_message(msg, '已执行，但返回值为空')
        elif len(res) <= 4000:
            await jdbot.delete_messages(chat_id, msg)
            await jdbot.send_message(chat_id, res)
        elif len(res) > 4000:
            _log = _LogDir + '/bot/'+cmdtext.split('/')[-1].split(
                '.js')[0]+datetime.datetime.now().strftime('%H-%M-%S')+'.log'
            with open(_log, 'w+', encoding='utf-8') as f:
                f.write(res)
            await jdbot.delete_messages(chat_id, msg)
            await jdbot.send_message(chat_id, '执行结果较长，请查看日志', file=_log)
            os.remove(_log)
    except Exception as e:
        await jdbot.send_message(chat_id, 'something wrong,I\'m sorry\n'+str(e))
        logger.error('something wrong,I\'m sorry'+str(e))


async def getname(path, dir):
    '''获取文件中文名称，如无则返回文件名'''
    names = []
    reg = r'new Env\(\'[\S]+?\'\)'
    cname = False
    for file in dir:
        if os.path.isdir(path+'/'+file):
            names.append(file)
        elif file.endswith('.js') and file != 'jdCookie.js' and file != 'getJDCookie.js' and file != 'JD_extra_cookie.js' and 'ShareCode' not in file:
            with open(path+'/'+file, 'r', encoding='utf-8') as f:
                resdatas = f.readlines()
            for data in resdatas:
                if 'new Env' in data:
                    data = data.replace('\"', '\'')
                    res = re.findall(reg, data)
                    if len(res) != 0:
                        res = res[0].split('\'')[-2]
                        names.append(res+'--->'+file)
                        cname = True
                    break
            if not cname:
                names.append(file+'--->'+file)
                cname = False
        else:
            continue
    return names


async def logbtn(conv, SENDER, path, msg, page, filelist):
    '''定义log日志按钮'''
    mybtn = [Button.inline('上一页', data='up'), Button.inline(
        '下一页', data='next'), Button.inline('上级', data='updir'), Button.inline('取消', data='cancel')]
    try:
        if filelist:
            markup = filelist
            newmarkup = markup[page]
            if mybtn not in newmarkup:
                newmarkup.append(mybtn)
        else:
            dir = os.listdir(path)
            dir.sort()
            markup = [Button.inline(file, data=str(file))
                      for file in dir]
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
            return path, msg, page, markup
        elif res == 'up':
            page = page - 1
            if page < 0:
                page = len(markup) - 1
            return path, msg, page, markup
        elif res == 'updir':
            path = '/'.join(path.split('/')[:-1])
            logger.info(path)
            if path == '':
                path = _JdDir
            return path, msg, page, None
        elif os.path.isfile(path+'/'+res):
            msg = await jdbot.edit_message(msg, '文件发送中，请注意查收')
            await conv.send_file(path+'/'+res)
            msg = await jdbot.edit_message(msg, res+'发送成功，请查收')
            conv.cancel()
            return None, None, None, None
        else:
            return path+'/'+res, msg, page, None
    except asyncio.exceptions.TimeoutError:
        msg = await jdbot.edit_message(msg, '选择已超时，本次对话已停止')
        return None, None, None, None
    except Exception as e:
        msg = await jdbot.edit_message(msg, 'something wrong,I\'m sorry\n'+str(e))
        logger.error('something wrong,I\'m sorry\n'+str(e))
        return None, None, None, None


async def nodebtn(conv, SENDER, path, msg, page, filelist):
    '''定义scripts脚本按钮'''
    mybtn = [Button.inline('上一页', data='up'), Button.inline(
        '下一页', data='next'), Button.inline('上级', data='updir'), Button.inline('取消', data='cancel')]
    try:
        if filelist:
            markup = filelist
            newmarkup = markup[page]
            if mybtn not in newmarkup:
                newmarkup.append(mybtn)
        else:
            if path == _JdDir and V4:
                dir = ['scripts', _OwnDir.split('/')[-1]]
            elif path == _JdDir and QL:
                dir = ['scripts']
            else:
                dir = os.listdir(path)
                dir = await getname(path, dir)
            dir.sort()
            markup = [Button.inline(file.split('--->')[0], data=str(file.split('--->')[-1]))
                      for file in dir if os.path.isdir(path+'/'+file) or file.endswith('.js')]
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
            return path, msg, page, markup
        elif res == 'up':
            page = page - 1
            if page < 0:
                page = len(markup) - 1
            return path, msg, page, markup
        elif res == 'updir':
            path = '/'.join(path.split('/')[:-1])
            if path == '':
                path = _JdDir
            return path, msg, page, None
        elif os.path.isfile(path+'/'+res):
            conv.cancel()
            logger.info(path+'/'+res+'脚本即将在后台运行')
            msg = await jdbot.edit_message(msg, res + '在后台运行成功')
            cmdtext = '{} {}/{} now'.format(jdcmd, path, res)
            return None, None, None, 'CMD-->'+cmdtext
        else:
            return path+'/'+res, msg, page, None
    except asyncio.exceptions.TimeoutError:
        msg = await jdbot.edit_message(msg, '选择已超时，对话已停止')
        return None, None, None, None
    except Exception as e:
        msg = await jdbot.edit_message(msg, 'something wrong,I\'m sorry\n'+str(e))
        logger.error('something wrong,I\'m sorry\n'+str(e))
        return None, None, None, None
