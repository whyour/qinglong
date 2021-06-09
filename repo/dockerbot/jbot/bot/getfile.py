from telethon import events, Button
import subprocess
from asyncio import exceptions
from .. import jdbot, chat_id, _ScriptsDir, _ConfigDir, logger
from .utils import press_event, backfile, _DiyDir, jdcmd, V4


@jdbot.on(events.NewMessage(from_users=chat_id))
async def myfile(event):
    '''定义文件操作'''
    try:
        v4btn = [[Button.inline('放入config', data=_ConfigDir), Button.inline('放入scripts', data=_ScriptsDir), Button.inline('放入OWN文件夹', data=_DiyDir)], [
            Button.inline('放入scripts并运行', data='node1'), Button.inline('放入OWN并运行', data='node'), Button.inline('取消', data='cancel')]]
        btn = [[Button.inline('放入config', data=_ConfigDir), Button.inline('放入scripts', data=_ScriptsDir)], [
            Button.inline('放入scripts并运行', data='node1'), Button.inline('取消', data='cancel')]]
        SENDER = event.sender_id
        if event.message.file:
            markup = []
            filename = event.message.file.name
            async with jdbot.conversation(SENDER, timeout=30) as conv:
                msg = await conv.send_message('请选择您要放入的文件夹或操作：\n')
                if V4:
                    markup = v4btn
                else:
                    markup = btn
                msg = await jdbot.edit_message(msg, '请选择您要放入的文件夹或操作：', buttons=markup)
                convdata = await conv.wait_event(press_event(SENDER))
                res = bytes.decode(convdata.data)
                if res == 'cancel':
                    msg = await jdbot.edit_message(msg, '对话已取消')
                    conv.cancel()
                elif res == 'node':
                    await backfile(_DiyDir+'/'+filename)
                    await jdbot.download_media(event.message, _DiyDir)
                    cmdtext = '{} {}/{} now'.format(jdcmd, _DiyDir, filename)
                    subprocess.Popen(
                        cmdtext, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    await jdbot.edit_message(msg, '脚本已保存到DIY文件夹，并成功在后台运行，请稍后自行查看日志')
                    conv.cancel()
                elif res == 'node1':
                    await backfile(_ScriptsDir+'/'+filename)
                    await jdbot.download_media(event.message, _ScriptsDir)
                    cmdtext = '{} {}/{} now'.format(jdcmd,
                                                    _ScriptsDir, filename)
                    subprocess.Popen(
                        cmdtext, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    await jdbot.edit_message(msg, '脚本已保存到scripts文件夹，并成功在后台运行，请稍后自行查看日志')
                    conv.cancel()
                else:
                    await backfile(res+'/'+filename)
                    await jdbot.download_media(event.message, res)
                    await jdbot.edit_message(msg, filename+'已保存到'+res+'文件夹')
            if filename == 'crontab.list' and V4:
                cmdtext = 'crontab '+res+'/'+filename
                subprocess.Popen(
                    cmdtext, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                await jdbot.edit_message(msg, '定时文件已保存，并更新')
    except exceptions.TimeoutError:
        msg = await jdbot.send_message(chat_id, '选择已超时，对话已停止')
    except Exception as e:
        await jdbot.send_message(chat_id, 'something wrong,I\'m sorry\n'+str(e))
        logger.error('something wrong,I\'m sorry\n'+str(e))
