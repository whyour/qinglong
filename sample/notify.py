#!/usr/bin/env python3
# _*_ coding:utf-8 _*_

import os
import re
import sys

cur_path = os.path.abspath(os.path.dirname(__file__))
root_path = os.path.split(cur_path)[0]
sys.path.append(root_path)

import base64
import hashlib
import hmac
import json5 as json
import requests
import time
import urllib.parse

# 通知服务
push_config = {
    'HITOKOTO': False,                  # 启用一言（随机句子）

    'BARK': '',                         # bark服务,自行搜索; 此参数如果以http或者https开头则判定为自建bark服务

    'SCKEY': '',                        # Server酱的SCKEY

    'TG_BOT_TOKEN': '',                 # tg机器人的TG_BOT_TOKEN; 1407203283:AAG9rt-6RDaaX0HBLZQq0laNOh898iFYaRQ
    'TG_USER_ID': '',                   # tg机器人的TG_USER_ID; 1434078534
    'TG_API_HOST': '',                  # tg 代理 api
    'TG_PROXY_IP': '',                  # tg 机器人的 TG_PROXY_IP
    'TG_PROXY_PORT': '',                # tg 机器人的 TG_PROXY_PORT

    'DD_BOT_ACCESS_TOKEN': '',          # 钉钉机器人的 DD_BOT_ACCESS_TOKEN
    'DD_BOT_SECRET': '',                # 钉钉机器人的 DD_BOT_SECRET

    'QQ_MODE': '',                      # qq 机器人的 QQ_MODE
    'QQ_SKEY': '',                      # qq 机器人的 QQ_SKEY

    'QYWX_APP': '',                      # 企业微信

    'PUSH_PLUS_TOKEN': '',              # 微信推送 Plus+

    'GOBOT_URL': '',                   # go-cqhttp
                                       # 推送到个人QQ: http://127.0.0.1/send_private_msg
                                       # 群：http://127.0.0.1/send_group_msg
    'GOBOT_TOKEN': '',                 # go-cqhttp 的 access_token, 可不填
    'GOBOT_QQ': '',                    # go-cqhttp的推送群或者用户
                                       # GOBOT_URL设置 /send_private_msg 填入 user_id=个人QQ
                                       #              /send_group_msg   填入 group_id=QQ群


}
notify_function = []

# 读取配置文件中的变量
CONFIG_PATH = os.getenv("NOTIFY_CONFIG_PATH") or "/ql/config/notify_config.json5"
if os.path.exists(CONFIG_PATH):
    for k, v in dict(json.load(open(CONFIG_PATH, mode="r", encoding="utf-8"))).items():
        if k in push_config:
            push_config[k] = v

#  GitHub action运行环境变量覆盖配置文件的变量
for k in push_config:
    if v := os.getenv(k):
        push_config[k] = v


def bark(title, content):
    print("\n")
    if not push_config.get('BARK'):
        print("bark 服务的 bark_token 未设置!!\n取消推送")
        return
    print("bark 服务启动")

    if push_config.get('BARK').startswith('http'):
        url = f"""{push_config.get('BARK')}/{title}/{content}"""
    else:
        url = f"""https://api.day.app/{push_config.get('BARK')}/{title}/{content}"""
    response = requests.get(url).json()

    if response['code'] == 200:
        print('bark 推送成功！')
    else:
        print('bark 推送失败！')


def go_cqhttp(title, content):
    print("\n")
    if not push_config.get('GOBOT_URL') or not push_config.get('GOBOT_QQ'):
        print("go-cqhttp 服务的 GOBOT_URL 或 GOBOT_QQ 未设置!!\n取消推送")
        return
    print("go-cqhttp 服务启动")

    url = f"""{push_config.get('GOBOT_URL')}?access_token={push_config.get('GOBOT_TOKEN')}&{push_config.get('GOBOT_QQ')}&message=标题:{title}\n内容:{content}"""
    response = requests.get(url).json()

    if response['status'] == 'ok':
        print('go-cqhttp 推送成功！')
    else:
        print('go-cqhttp 推送失败！')


def serverJ(title, content):
    print("\n")
    if not push_config.get('SCKEY'):
        print("server 酱服务的 SCKEY 未设置!!\n取消推送")
        return
    print("serverJ 服务启动")

    data = {
        "text": title,
        "desp": content.replace("\n", "\n\n")
    }
    response = requests.post(f"https://sct.ftqq.com/{push_config.get('SCKEY')}.send", data=data).json()

    if response['errno'] == 0:
        print('serverJ 推送成功！')
    else:
        print('serverJ 推送失败！')


# tg通知
def telegram_bot(title, content):
    print("\n")
    if not push_config.get('TG_BOT_TOKEN') or not push_config.get('TG_USER_ID'):
        print("tg 服务的 bot_token 或者 user_id 未设置!!\n取消推送")
        return
    print("tg 服务启动")

    if push_config.get('TG_API_HOST'):
        url = f"https://{push_config.get('TG_API_HOST')}/bot{push_config.get('TG_BOT_TOKEN')}/sendMessage"
    else:
        url = f"https://api.telegram.org/bot{push_config.get('TG_BOT_TOKEN')}/sendMessage"
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}
    payload = {'chat_id': str(push_config.get('TG_USER_ID')), 'text': f'{title}\n\n{content}',
               'disable_web_page_preview': 'true'}
    proxies = None
    if push_config.get('TG_PROXY_IP') and push_config.get('TG_PROXY_PORT'):
        proxyStr = "http://{}:{}".format(push_config.get('TG_PROXY_IP'), push_config.get('TG_PROXY_PORT'))
        proxies = {"http": proxyStr, "https": proxyStr}
    response = requests.post(url=url, headers=headers, params=payload, proxies=proxies).json()

    if response['ok']:
        print('tg 推送成功！')
    else:
        print('tg 推送失败！')


def dingding_bot(title, content):
    print("\n")
    if not push_config.get('DD_BOT_SECRET') or not push_config.get('DD_BOT_ACCESS_TOKEN'):
        print("钉钉机器人 服务的 DD_BOT_SECRET 或者 DD_BOT_ACCESS_TOKEN 未设置!!\n取消推送")
        return
    print("钉钉机器人 服务启动")

    timestamp = str(round(time.time() * 1000))
    secret_enc = push_config.get('DD_BOT_SECRET').encode('utf-8')
    string_to_sign = '{}\n{}'.format(timestamp, push_config.get('DD_BOT_SECRET'))
    string_to_sign_enc = string_to_sign.encode('utf-8')
    hmac_code = hmac.new(secret_enc, string_to_sign_enc, digestmod=hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    url = f'https://oapi.dingtalk.com/robot/send?access_token={push_config.get("DD_BOT_ACCESS_TOKEN")}&timestamp={timestamp}&sign={sign}'
    headers = {'Content-Type': 'application/json;charset=utf-8'}
    data = {
        'msgtype': 'text',
        'text': {'content': f'{title}\n\n{content}'}
    }
    response = requests.post(url=url, data=json.dumps(data), headers=headers, timeout=15).json()

    if not response['errcode']:
        print('钉钉机器人 推送成功！')
    else:
        print('钉钉机器人 推送失败！')


def coolpush_bot(title, content):
    print("\n")
    if not push_config.get('QQ_SKEY') or not push_config.get('QQ_MODE'):
        print("qmsg 的 QQ_SKEY 或者 QQ_MODE 未设置!!\n取消推送")
        return
    print("qmsg 启动")

    url = f"https://qmsg.zendee.cn/{push_config.get('QQ_MODE')}/{push_config.get('QQ_SKEY')}"
    payload = {'msg': f"{title}\n\n{content}".encode('utf-8')}
    response = requests.post(url=url, params=payload).json()

    if response['code'] == 0:
        print('qmsg 推送成功！')
    else:
        print('qmsg 推送失败！')


# push推送
def pushplus_bot(title, content):
    print("\n")
    if not push_config.get('PUSH_PLUS_TOKEN'):
        print("PUSHPLUS 服务的token未设置!!\n取消推送")
        return
    print("PUSHPLUS 服务启动")

    url = 'http://www.pushplus.plus/send'
    data = {
        "token": push_config.get('PUSH_PLUS_TOKEN'),
        "title": title,
        "content": content
    }
    body = json.dumps(data).encode(encoding='utf-8')
    headers = {'Content-Type': 'application/json'}
    response = requests.post(url=url, data=body, headers=headers).json()

    if response['code'] == 200:
        print('PUSHPLUS 推送成功！')
    else:
        print('PUSHPLUS 推送失败！')

def qywxapp_bot(title, content):
    print("\n")
    if not QYWX_APP:
        print("企业微信应用的QYWX_APP未设置!!\n取消推送")
        return
    print("企业微信应用启动")
    qywx_app_params = QYWX_APP.split(',')
    url='https://qyapi.weixin.qq.com/cgi-bin/gettoken'
    headers= {
        'Content-Type': 'application/json',
    }
    payload = {
        'corpid': qywx_app_params[0],
        'corpsecret': qywx_app_params[1],
    }
    response = requests.post(url=url, headers=headers, data=json.dumps(payload), timeout=15).json()
    accesstoken = response["access_token"]
    html = content.replace("\n", "<br/>")

    options = None
    if not qywx_app_params[4]:
        options = {
            'msgtype': 'text',
            'text': {
                content: f'{title}\n\n${content}'
            }
        }
    elif qywx_app_params[4] == '0':
        options = {
            'msgtype': 'textcard',
            'textcard': {
                title: f'{title}',
                description: f'{content}',
                btntxt: '更多'
            }
        }
    elif qywx_app_params[4] == '1':
        options = {
            'msgtype': 'text',
            'text': {
                content: f'{title}\n\n${content}'
            }
        }
    else:
        options = {
            'msgtype': 'mpnews',
            'mpnews': {
                'articles': [
                    {
                        'title': f'{title}',
                        'thumb_media_id': f'{qywx_app_params[4]}',
                        'author': '智能助手',
                        'content_source_url': '',
                        'content': f'{html}',
                        'digest': f'{content}'
                    }
                ]
            }
        }

    url=f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={accesstoken}"
    data = {
        'touser': f'{change_user_id(content)}',
        'agentid': f'{qywx_app_params[3]}',
        'safe': '0'
    }
    data.update(options)
    headers = {
        'Content-Type': 'application/json',
    }
    response = requests.post(url=url, headers=headers, data=json.dumps(data)).json()

    if response['errcode'] == 0:
        print('推送成功！')
    else:
        print('推送失败！')

def change_user_id(desp):
    qywx_app_params = QYWX_APP.split(',')
    if qywx_app_params[2]:
        userIdTmp = qywx_app_params[2].split("|")
        userId = ""
        for i in range(len(userIdTmp)):
            count1 = f"账号{i + 1}"
            count2 = f"签到号{i + 1}"
            if re.search(count1, desp) or re.search(count2, desp):
                userId = userIdTmp[i]
        if not userId:
            userId = qywx_app_params[2]
        return userId
    else:
        return "@all"

def one():
    url = 'https://v1.hitokoto.cn/'
    res = requests.get(url).json()
    return res['hitokoto'] + '    ----' + res['from']


if push_config.get('BARK'):
    notify_function.append(bark)
if push_config.get('GOBOT_URL') and push_config.get('GOBOT_QQ'):
    notify_function.append(go_cqhttp)
if push_config.get('SCKEY'):
    notify_function.append(serverJ)
if push_config.get('TG_BOT_TOKEN') and push_config.get('TG_USER_ID'):
    notify_function.append(telegram_bot)
if push_config.get('DD_BOT_ACCESS_TOKEN') and push_config.get('DD_BOT_SECRET'):
    notify_function.append(dingding_bot)
if push_config.get('QQ_SKEY') and push_config.get('QQ_MODE'):
    notify_function.append(coolpush_bot)
if push_config.get('PUSH_PLUS_TOKEN'):
    notify_function.append(pushplus_bot)
if push_config.get('QYWX_AM'):
    notify_function.append(wecom_app)


def send(title, content):
    hitokoto = push_config.get('HITOKOTO')

    text = one() if hitokoto else ''
    content += '\n\n' + text

    for mode in notify_function:
        try:
            mode(title=title, content=content)
        except requests.exceptions.RequestException as e:
            print(f"网络请求失败： {str(e)}, {mode.__name__}")


def main():
    send('title', 'content')


if __name__ == '__main__':
    main()
