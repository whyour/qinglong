#!/usr/bin/env python3
# _*_ coding:utf-8 _*_
import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.parse
import smtplib
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

import requests

# 原先的 print 函数和主线程的锁
_print = print
mutex = threading.Lock()


# 定义新的 print 函数
def print(text, *args, **kw):
    """
    使输出有序进行，不出现多线程同一时间输出导致错乱的问题。
    """
    with mutex:
        _print(text, *args, **kw)


# 通知服务
# fmt: off
push_config = {
    'HITOKOTO': False,                  # 启用一言（随机句子）

    'BARK_PUSH': '',                    # bark IP 或设备码，例：https://api.day.app/DxHcxxxxxRxxxxxxcm/
    'BARK_ARCHIVE': '',                 # bark 推送是否存档
    'BARK_GROUP': '',                   # bark 推送分组
    'BARK_SOUND': '',                   # bark 推送声音
    'BARK_ICON': '',                    # bark 推送图标
    'BARK_LEVEL': '',                   # bark 推送时效性
    'BARK_URL': '',                     # bark 推送跳转URL

    'CONSOLE': True,                    # 控制台输出

    'DD_BOT_SECRET': '',                # 钉钉机器人的 DD_BOT_SECRET
    'DD_BOT_TOKEN': '',                 # 钉钉机器人的 DD_BOT_TOKEN

    'FSKEY': '',                        # 飞书机器人的 FSKEY

    'GOBOT_URL': '',                    # go-cqhttp
                                        # 推送到个人QQ：http://127.0.0.1/send_private_msg
                                        # 群：http://127.0.0.1/send_group_msg
    'GOBOT_QQ': '',                     # go-cqhttp 的推送群或用户
                                        # GOBOT_URL 设置 /send_private_msg 时填入 user_id=个人QQ
                                        #               /send_group_msg   时填入 group_id=QQ群
    'GOBOT_TOKEN': '',                  # go-cqhttp 的 access_token

    'GOTIFY_URL': '',                   # gotify地址,如https://push.example.de:8080
    'GOTIFY_TOKEN': '',                 # gotify的消息应用token
    'GOTIFY_PRIORITY': 0,               # 推送消息优先级,默认为0

    'IGOT_PUSH_KEY': '',                # iGot 聚合推送的 IGOT_PUSH_KEY

    'PUSH_KEY': '',                     # server 酱的 PUSH_KEY，兼容旧版与 Turbo 版

    'DEER_KEY': '',                     # PushDeer 的 PUSHDEER_KEY
    'DEER_URL': '',                     # PushDeer 的 PUSHDEER_URL

    'CHAT_URL': '',                     # synology chat url
    'CHAT_TOKEN': '',                   # synology chat token

    'PUSH_PLUS_TOKEN': '',              # push+ 微信推送的用户令牌
    'PUSH_PLUS_USER': '',               # push+ 微信推送的群组编码

    'QMSG_KEY': '',                     # qmsg 酱的 QMSG_KEY
    'QMSG_TYPE': '',                    # qmsg 酱的 QMSG_TYPE

    'QYWX_ORIGIN': '',                  # 企业微信代理地址

    'QYWX_AM': '',                      # 企业微信应用

    'QYWX_KEY': '',                     # 企业微信机器人

    'TG_BOT_TOKEN': '',                 # tg 机器人的 TG_BOT_TOKEN，例：1407203283:AAG9rt-6RDaaX0HBLZQq0laNOh898iFYaRQ
    'TG_USER_ID': '',                   # tg 机器人的 TG_USER_ID，例：1434078534
    'TG_API_HOST': '',                  # tg 代理 api
    'TG_PROXY_AUTH': '',                # tg 代理认证参数
    'TG_PROXY_HOST': '',                # tg 机器人的 TG_PROXY_HOST
    'TG_PROXY_PORT': '',                # tg 机器人的 TG_PROXY_PORT

    'AIBOTK_KEY': '',                   # 智能微秘书 个人中心的apikey 文档地址：http://wechat.aibotk.com/docs/about
    'AIBOTK_TYPE': '',                  # 智能微秘书 发送目标 room 或 contact
    'AIBOTK_NAME': '',                  # 智能微秘书  发送群名 或者好友昵称和type要对应好

    'SMTP_SERVER': '',                  # SMTP 发送邮件服务器，形如 smtp.exmail.qq.com:465
    'SMTP_SSL': 'false',                # SMTP 发送邮件服务器是否使用 SSL，填写 true 或 false
    'SMTP_EMAIL': '',                   # SMTP 收发件邮箱，通知将会由自己发给自己
    'SMTP_PASSWORD': '',                # SMTP 登录密码，也可能为特殊口令，视具体邮件服务商说明而定
    'SMTP_NAME': '',                    # SMTP 收发件人姓名，可随意填写

    'PUSHME_KEY': '',                   # PushMe 酱的 PUSHME_KEY

    'CHRONOCAT_QQ': '',                 # qq号
    'CHRONOCAT_TOKEN': '',              # CHRONOCAT 的token
    'CHRONOCAT_URL': '',                # CHRONOCAT的url地址

    'WEBHOOK_URL': '',                  # 自定义通知 请求地址
    'WEBHOOK_BODY': '',                 # 自定义通知 请求体
    'WEBHOOK_HEADERS': '',              # 自定义通知 请求头
    'WEBHOOK_METHOD': '',               # 自定义通知 请求方法
    'WEBHOOK_CONTENT_TYPE': ''          # 自定义通知 content-type
}
notify_function = []
# fmt: on

# 首先读取 面板变量 或者 github action 运行变量
for k in push_config:
    if os.getenv(k):
        v = os.getenv(k)
        push_config[k] = v


def bark(title: str, content: str, **kwargs) -> None:
    """
    使用 bark 推送消息。
    """
    if not (push_config.get("BARK_PUSH") or kwargs.get("BARK_PUSH")):
        print("bark 服务的 BARK_PUSH 未设置!!\n取消推送")
        return
    print("bark 服务启动")
    BARK_PUSH = kwargs.get("BARK_PUSH", push_config.get("BARK_PUSH"))
    if BARK_PUSH.startswith("http"):
        url = f"{BARK_PUSH}/{urllib.parse.quote_plus(title)}/{urllib.parse.quote_plus(content)}"
    else:
        url = f"https://api.day.app/{BARK_PUSH}/{urllib.parse.quote_plus(title)}/{urllib.parse.quote_plus(content)}"

    bark_params = {
        "BARK_ARCHIVE": "isArchive",
        "BARK_GROUP": "group",
        "BARK_SOUND": "sound",
        "BARK_ICON": "icon",
        "BARK_LEVEL": "level",
        "BARK_URL": "url",
    }
    params = ""
    for pair in filter(
        lambda pairs: pairs[0].startswith("BARK_")
        and pairs[0] != "BARK_PUSH"
        and (pairs[1] or kwargs.get(pairs[0]))
        and bark_params.get(pairs[0]),
        push_config.items(),
    ):
        value = kwargs.get(pair[0], pair[1])
        params += f"{bark_params.get(pair[0])}={value}&"
    if params:
        url = url + "?" + params.rstrip("&")
    response = requests.get(url).json()

    if response["code"] == 200:
        print("bark 推送成功！")
    else:
        print("bark 推送失败！")


def console(title: str, content: str, **kwargs) -> None:
    """
    使用 控制台 推送消息。
    """
    print(f"{title}\n\n{content}")


def dingding_bot(title: str, content: str, **kwargs) -> None:
    """
    使用 钉钉机器人 推送消息。
    """
    if not (
        (kwargs.get("DD_BOT_SECRET") and kwargs.get("DD_BOT_TOKEN"))
        or (push_config.get("DD_BOT_SECRET") and push_config.get("DD_BOT_TOKEN"))
    ):
        print("钉钉机器人 服务的 DD_BOT_SECRET 或者 DD_BOT_TOKEN 未设置!!\n取消推送")
        return
    print("钉钉机器人 服务启动")
    if kwargs.get("DD_BOT_SECRET") and kwargs.get("DD_BOT_TOKEN"):
        DD_BOT_SECRET = kwargs.get("DD_BOT_SECRET")
        DD_BOT_TOKEN = kwargs.get("DD_BOT_TOKEN")
    else:
        DD_BOT_SECRET = push_config.get("DD_BOT_SECRET")
        DD_BOT_TOKEN = push_config.get("DD_BOT_TOKEN")

    timestamp = str(round(time.time() * 1000))
    secret_enc = DD_BOT_SECRET.encode("utf-8")
    string_to_sign = "{}\n{}".format(timestamp, DD_BOT_SECRET)
    string_to_sign_enc = string_to_sign.encode("utf-8")
    hmac_code = hmac.new(
        secret_enc, string_to_sign_enc, digestmod=hashlib.sha256
    ).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    url = f"https://oapi.dingtalk.com/robot/send?access_token={DD_BOT_TOKEN}&timestamp={timestamp}&sign={sign}"
    headers = {"Content-Type": "application/json;charset=utf-8"}
    data = {"msgtype": "text", "text": {"content": f"{title}\n\n{content}"}}
    response = requests.post(
        url=url, data=json.dumps(data), headers=headers, timeout=15
    ).json()

    if not response["errcode"]:
        print("钉钉机器人 推送成功！")
    else:
        print("钉钉机器人 推送失败！")


def feishu_bot(title: str, content: str, **kwargs) -> None:
    """
    使用 飞书机器人 推送消息。
    """
    if not (kwargs.get("DD_BOT_SECRET") or push_config.get("FSKEY")):
        print("飞书 服务的 FSKEY 未设置!!\n取消推送")
        return
    print("飞书 服务启动")
    FSKEY = kwargs.get("DD_BOT_SECRET", push_config.get("FSKEY"))
    url = f"https://open.feishu.cn/open-apis/bot/v2/hook/{FSKEY}"
    data = {"msg_type": "text", "content": {"text": f"{title}\n\n{content}"}}
    response = requests.post(url, data=json.dumps(data)).json()

    if response.get("StatusCode") == 0:
        print("飞书 推送成功！")
    else:
        print("飞书 推送失败！错误信息如下：\n", response)


def go_cqhttp(title: str, content: str, **kwargs) -> None:
    """
    使用 go_cqhttp 推送消息。
    """
    if not (
        (kwargs.get("GOBOT_URL") and kwargs.get("GOBOT_QQ"))
        or (push_config.get("GOBOT_URL") and push_config.get("GOBOT_QQ"))
    ):
        print("go-cqhttp 服务的 GOBOT_URL 或 GOBOT_QQ 未设置!!\n取消推送")
        return
    print("go-cqhttp 服务启动")
    if kwargs.get("GOBOT_URL") and kwargs.get("GOBOT_QQ"):
        GOBOT_URL = kwargs.get("GOBOT_URL")
        GOBOT_QQ = kwargs.get("GOBOT_QQ")
        GOBOT_TOKEN = kwargs.get("GOBOT_TOKEN")
    else:
        GOBOT_URL = push_config.get("GOBOT_URL")
        GOBOT_QQ = push_config.get("GOBOT_QQ")
        GOBOT_TOKEN = push_config.get("GOBOT_TOKEN")

    url = f"{GOBOT_URL}?access_token={GOBOT_TOKEN}&{GOBOT_QQ}&message=标题:{title}\n内容:{content}"
    response = requests.get(url).json()

    if response["status"] == "ok":
        print("go-cqhttp 推送成功！")
    else:
        print("go-cqhttp 推送失败！")


def gotify(title: str, content: str, **kwargs) -> None:
    """
    使用 gotify 推送消息。
    """
    if not (
        (kwargs.get("GOTIFY_URL") and kwargs.get("GOTIFY_TOKEN"))
        or (push_config.get("GOTIFY_URL") and push_config.get("GOTIFY_TOKEN"))
    ):
        print("gotify 服务的 GOTIFY_URL 或 GOTIFY_TOKEN 未设置!!\n取消推送")
        return
    print("gotify 服务启动")
    if kwargs.get("GOTIFY_URL") and kwargs.get("GOTIFY_TOKEN"):
        GOTIFY_URL = kwargs.get("GOTIFY_URL")
        GOTIFY_TOKEN = kwargs.get("GOBOTGOTIFY_TOKEN_QQ")
        GOTIFY_PRIORITY = kwargs.get("GOTIFY_PRIORITY")
    else:
        GOTIFY_URL = push_config.get("GOTIFY_URL")
        GOTIFY_TOKEN = push_config.get("GOTIFY_TOKEN")
        GOTIFY_PRIORITY = kwargs.get("GOTIFY_PRIORITY")

    url = f"{GOTIFY_URL}/message?token={GOTIFY_TOKEN}"
    data = {
        "title": title,
        "message": content,
        "priority": GOTIFY_PRIORITY,
    }
    response = requests.post(url, data=data).json()

    if response.get("id"):
        print("gotify 推送成功！")
    else:
        print("gotify 推送失败！")


def iGot(title: str, content: str, **kwargs) -> None:
    """
    使用 iGot 推送消息。
    """
    if not (kwargs.get("IGOT_PUSH_KEY") or push_config.get("IGOT_PUSH_KEY")):
        print("iGot 服务的 IGOT_PUSH_KEY 未设置!!\n取消推送")
        return
    print("iGot 服务启动")
    IGOT_PUSH_KEY = kwargs.get("IGOT_PUSH_KEY", push_config.get("IGOT_PUSH_KEY"))
    url = f"https://push.hellyw.com/{IGOT_PUSH_KEY}"
    data = {"title": title, "content": content}
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    response = requests.post(url, data=data, headers=headers).json()

    if response["ret"] == 0:
        print("iGot 推送成功！")
    else:
        print(f'iGot 推送失败！{response["errMsg"]}')


def serverJ(title: str, content: str, **kwargs) -> None:
    """
    通过 serverJ 推送消息。
    """
    if not (kwargs.get("PUSH_KEY") or push_config.get("PUSH_KEY")):
        print("serverJ 服务的 PUSH_KEY 未设置!!\n取消推送")
        return
    print("serverJ 服务启动")
    PUSH_KEY = kwargs.get("PUSH_KEY", push_config.get("PUSH_KEY"))

    data = {"text": title, "desp": content.replace("\n", "\n\n")}
    if PUSH_KEY.find("SCT") != -1:
        url = f"https://sctapi.ftqq.com/{PUSH_KEY}.send"
    else:
        url = f"https://sc.ftqq.com/{PUSH_KEY}.send"
    response = requests.post(url, data=data).json()

    if response.get("errno") == 0 or response.get("code") == 0:
        print("serverJ 推送成功！")
    else:
        print(f'serverJ 推送失败！错误码：{response["message"]}')


def pushdeer(title: str, content: str, **kwargs) -> None:
    """
    通过PushDeer 推送消息
    """
    if not (kwargs.get("DEER_KEY") or push_config.get("DEER_KEY")):
        print("PushDeer 服务的 DEER_KEY 未设置!!\n取消推送")
        return
    print("PushDeer 服务启动")
    DEER_KEY = kwargs.get("DEER_KEY", push_config.get("DEER_KEY"))

    data = {
        "text": title,
        "desp": content,
        "type": "markdown",
        "pushkey": DEER_KEY,
    }
    url = "https://api2.pushdeer.com/message/push"
    if push_config.get("DEER_URL"):
        url = push_config.get("DEER_URL")
    if kwargs.get("DEER_URL"):
        url = kwargs.get("DEER_URL")

    response = requests.post(url, data=data).json()

    if len(response.get("content").get("result")) > 0:
        print("PushDeer 推送成功！")
    else:
        print("PushDeer 推送失败！错误信息：", response)


def chat(title: str, content: str, **kwargs) -> None:
    """
    通过Chat 推送消息
    """
    if not (
        (kwargs.get("CHAT_URL") and kwargs.get("CHAT_TOKEN"))
        or (push_config.get("CHAT_URL") and push_config.get("CHAT_TOKEN"))
    ):
        print("chat 服务的 CHAT_URL或CHAT_TOKEN 未设置!!\n取消推送")
        return
    print("chat 服务启动")
    if kwargs.get("CHAT_URL") and kwargs.get("CHAT_TOKEN"):
        CHAT_URL = kwargs.get("CHAT_URL")
        CHAT_TOKEN = kwargs.get("CHAT_TOKEN")
    else:
        CHAT_URL = push_config.get("CHAT_URL")
        CHAT_TOKEN = push_config.get("CHAT_TOKEN")

    data = "payload=" + json.dumps({"text": title + "\n" + content})
    url = CHAT_URL + CHAT_TOKEN
    response = requests.post(url, data=data)

    if response.status_code == 200:
        print("Chat 推送成功！")
    else:
        print("Chat 推送失败！错误信息：", response)


def pushplus_bot(title: str, content: str, **kwargs) -> None:
    """
    通过 push+ 推送消息。
    """
    if not (kwargs.get("PUSH_PLUS_TOKEN") or push_config.get("PUSH_PLUS_TOKEN")):
        print("PUSHPLUS 服务的 PUSH_PLUS_TOKEN 未设置!!\n取消推送")
        return
    print("PUSHPLUS 服务启动")
    PUSH_PLUS_TOKEN = kwargs.get("PUSH_PLUS_TOKEN", push_config.get("PUSH_PLUS_TOKEN"))
    PUSH_PLUS_USER = kwargs.get("PUSH_PLUS_USER", push_config.get("PUSH_PLUS_USER"))

    url = "http://www.pushplus.plus/send"
    data = {
        "token": PUSH_PLUS_TOKEN,
        "title": title,
        "content": content,
        "topic": PUSH_PLUS_USER,
    }
    body = json.dumps(data).encode(encoding="utf-8")
    headers = {"Content-Type": "application/json"}
    response = requests.post(url=url, data=body, headers=headers).json()

    if response["code"] == 200:
        print("PUSHPLUS 推送成功！")

    else:
        url_old = "http://pushplus.hxtrip.com/send"
        headers["Accept"] = "application/json"
        response = requests.post(url=url_old, data=body, headers=headers).json()

        if response["code"] == 200:
            print("PUSHPLUS(hxtrip) 推送成功！")

        else:
            print("PUSHPLUS 推送失败！")


def qmsg_bot(title: str, content: str, **kwargs) -> None:
    """
    使用 qmsg 推送消息。
    """
    if not (
        (kwargs.get("QMSG_KEY") and kwargs.get("QMSG_TYPE"))
        or (push_config.get("QMSG_KEY") and push_config.get("QMSG_TYPE"))
    ):
        print("qmsg 的 QMSG_KEY 或者 QMSG_TYPE 未设置!!\n取消推送")
        return
    print("qmsg 服务启动")
    if kwargs.get("QMSG_KEY") and kwargs.get("QMSG_TYPE"):
        QMSG_KEY = kwargs.get("QMSG_KEY")
        QMSG_TYPE = kwargs.get("QMSG_TYPE")
    else:
        QMSG_KEY = push_config.get("QMSG_KEY")
        QMSG_TYPE = push_config.get("QMSG_TYPE")

    url = f"https://qmsg.zendee.cn/{QMSG_TYPE}/{QMSG_KEY}"
    payload = {"msg": f'{title}\n\n{content.replace("----", "-")}'.encode("utf-8")}
    response = requests.post(url=url, params=payload).json()

    if response["code"] == 0:
        print("qmsg 推送成功！")
    else:
        print(f'qmsg 推送失败！{response["reason"]}')


def wecom_app(title: str, content: str, **kwargs) -> None:
    """
    通过 企业微信 APP 推送消息。
    """
    if not (kwargs.get("QYWX_AM") or push_config.get("QYWX_AM")):
        print("QYWX_AM 未设置!!\n取消推送")
        return
    QYWX_AM = kwargs.get("QYWX_AM", push_config.get("QYWX_AM"))
    QYWX_AM_AY = re.split(",", QYWX_AM)
    if 4 < len(QYWX_AM_AY) > 5:
        print("QYWX_AM 设置错误!!\n取消推送")
        return
    print("企业微信 APP 服务启动")

    corpid = QYWX_AM_AY[0]
    corpsecret = QYWX_AM_AY[1]
    touser = QYWX_AM_AY[2]
    agentid = QYWX_AM_AY[3]
    try:
        media_id = QYWX_AM_AY[4]
    except IndexError:
        media_id = ""
    wx = WeCom(corpid, corpsecret, agentid)
    # 如果没有配置 media_id 默认就以 text 方式发送
    if not media_id:
        message = title + "\n\n" + content
        response = wx.send_text(message, touser)
    else:
        response = wx.send_mpnews(title, content, media_id, touser)

    if response == "ok":
        print("企业微信推送成功！")
    else:
        print("企业微信推送失败！错误信息如下：\n", response)


class WeCom:
    def __init__(self, corpid, corpsecret, agentid):
        self.CORPID = corpid
        self.CORPSECRET = corpsecret
        self.AGENTID = agentid
        self.ORIGIN = "https://qyapi.weixin.qq.com"
        if push_config.get("QYWX_ORIGIN"):
            self.ORIGIN = push_config.get("QYWX_ORIGIN")

    def get_access_token(self):
        url = f"{self.ORIGIN}/cgi-bin/gettoken"
        values = {
            "corpid": self.CORPID,
            "corpsecret": self.CORPSECRET,
        }
        req = requests.post(url, params=values)
        data = json.loads(req.text)
        return data["access_token"]

    def send_text(self, message, touser="@all"):
        send_url = (
            f"{self.ORIGIN}/cgi-bin/message/send?access_token={self.get_access_token()}"
        )
        send_values = {
            "touser": touser,
            "msgtype": "text",
            "agentid": self.AGENTID,
            "text": {"content": message},
            "safe": "0",
        }
        send_msges = bytes(json.dumps(send_values), "utf-8")
        respone = requests.post(send_url, send_msges)
        respone = respone.json()
        return respone["errmsg"]

    def send_mpnews(self, title, message, media_id, touser="@all"):
        send_url = (
            f"{self.ORIGIN}/cgi-bin/message/send?access_token={self.get_access_token()}"
        )
        send_values = {
            "touser": touser,
            "msgtype": "mpnews",
            "agentid": self.AGENTID,
            "mpnews": {
                "articles": [
                    {
                        "title": title,
                        "thumb_media_id": media_id,
                        "author": "Author",
                        "content_source_url": "",
                        "content": message.replace("\n", "<br/>"),
                        "digest": message,
                    }
                ]
            },
        }
        send_msges = bytes(json.dumps(send_values), "utf-8")
        respone = requests.post(send_url, send_msges)
        respone = respone.json()
        return respone["errmsg"]


def wecom_bot(title: str, content: str, **kwargs) -> None:
    """
    通过 企业微信机器人 推送消息。
    """
    if not (kwargs.get("QYWX_KEY") or push_config.get("QYWX_KEY")):
        print("企业微信机器人 服务的 QYWX_KEY 未设置!!\n取消推送")
        return
    print("企业微信机器人服务启动")
    QYWX_KEY = kwargs.get("QYWX_KEY", push_config.get("QYWX_KEY"))

    origin = "https://qyapi.weixin.qq.com"
    if push_config.get("QYWX_ORIGIN"):
        origin = push_config.get("QYWX_ORIGIN")
    if kwargs.get("QYWX_ORIGIN"):
        origin = kwargs.get("QYWX_ORIGIN")

    url = f"{origin}/cgi-bin/webhook/send?key={QYWX_KEY}"
    headers = {"Content-Type": "application/json;charset=utf-8"}
    data = {"msgtype": "text", "text": {"content": f"{title}\n\n{content}"}}
    response = requests.post(
        url=url, data=json.dumps(data), headers=headers, timeout=15
    ).json()

    if response["errcode"] == 0:
        print("企业微信机器人推送成功！")
    else:
        print("企业微信机器人推送失败！")


def telegram_bot(title: str, content: str, **kwargs) -> None:
    """
    使用 telegram 机器人 推送消息。
    """
    if not (
        (kwargs.get("TG_BOT_TOKEN") and kwargs.get("TG_USER_ID"))
        or (push_config.get("TG_BOT_TOKEN") and push_config.get("TG_USER_ID"))
    ):
        print("tg 服务的 TG_BOT_TOKEN 或者 TG_USER_ID 未设置!!\n取消推送")
        return
    print("tg 服务启动")
    if kwargs.get("TG_BOT_TOKEN") and kwargs.get("TG_USER_ID"):
        TG_BOT_TOKEN = kwargs.get("TG_BOT_TOKEN")
        TG_USER_ID = kwargs.get("TG_USER_ID")
    else:
        TG_BOT_TOKEN = push_config.get("TG_BOT_TOKEN")
        TG_USER_ID = push_config.get("TG_USER_ID")

    if kwargs.get("TG_API_HOST") or push_config.get("TG_API_HOST"):
        TG_API_HOST = kwargs.get("TG_API_HOST", push_config.get("TG_API_HOST"))
        url = f"{TG_API_HOST}/bot{TG_BOT_TOKEN}/sendMessage"
    else:
        url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    payload = {
        "chat_id": str(TG_USER_ID),
        "text": f"{title}\n\n{content}",
        "disable_web_page_preview": "true",
    }
    proxies = None
    if not (
        (kwargs.get("TG_PROXY_HOST") and kwargs.get("TG_PROXY_PORT"))
        or (push_config.get("TG_PROXY_HOST") and push_config.get("TG_PROXY_PORT"))
    ):
        if kwargs.get("TG_PROXY_HOST") and kwargs.get("TG_PROXY_PORT"):
            TG_PROXY_HOST = kwargs.get("TG_PROXY_HOST")
            TG_PROXY_PORT = kwargs.get("TG_PROXY_PORT")
        else:
            TG_PROXY_HOST = kwargs.get("TG_PROXY_HOST")
            TG_PROXY_PORT = kwargs.get("TG_PROXY_PORT")
        if kwargs.get("TG_PROXY_AUTH") or push_config.get("TG_PROXY_AUTH"):
            TG_PROXY_AUTH = kwargs.get(
                "TG_PROXY_AUTH", push_config.get("TG_PROXY_AUTH")
            )
        if TG_PROXY_AUTH is not None and "@" not in TG_PROXY_HOST:
            TG_PROXY_HOST = TG_PROXY_AUTH + "@" + TG_PROXY_HOST
        proxyStr = "http://{}:{}".format(TG_PROXY_HOST, TG_PROXY_PORT)
        proxies = {"http": proxyStr, "https": proxyStr}
    response = requests.post(
        url=url, headers=headers, params=payload, proxies=proxies
    ).json()

    if response["ok"]:
        print("tg 推送成功！")
    else:
        print("tg 推送失败！")


def aibotk(title: str, content: str, **kwargs) -> None:
    """
    使用 智能微秘书 推送消息。
    """
    if not (
        (
            kwargs.get("AIBOTK_KEY")
            and kwargs.get("AIBOTK_TYPE")
            and kwargs.get("AIBOTK_NAME")
        )
        or (
            push_config.get("AIBOTK_KEY")
            and push_config.get("AIBOTK_TYPE")
            and push_config.get("AIBOTK_NAME")
        )
    ):
        print(
            "智能微秘书 的 AIBOTK_KEY 或者 AIBOTK_TYPE 或者 AIBOTK_NAME 未设置!!\n取消推送"
        )
        return
    print("智能微秘书 服务启动")
    if (
        kwargs.get("AIBOTK_KEY")
        and kwargs.get("AIBOTK_TYPE")
        and kwargs.get("AIBOTK_NAME")
    ):
        AIBOTK_KEY = kwargs.get("AIBOTK_KEY")
        AIBOTK_TYPE = kwargs.get("AIBOTK_TYPE")
        AIBOTK_NAME = kwargs.get("AIBOTK_NAME")
    else:
        AIBOTK_KEY = push_config.get("AIBOTK_KEY")
        AIBOTK_TYPE = push_config.get("AIBOTK_TYPE")
        AIBOTK_NAME = push_config.get("AIBOTK_NAME")
    if AIBOTK_TYPE == "room":
        url = "https://api-bot.aibotk.com/openapi/v1/chat/room"
        data = {
            "apiKey": AIBOTK_KEY,
            "roomName": AIBOTK_NAME,
            "message": {"type": 1, "content": f"【青龙快讯】\n\n{title}\n{content}"},
        }
    else:
        url = "https://api-bot.aibotk.com/openapi/v1/chat/contact"
        data = {
            "apiKey": AIBOTK_KEY,
            "name": AIBOTK_NAME,
            "message": {"type": 1, "content": f"【青龙快讯】\n\n{title}\n{content}"},
        }
    body = json.dumps(data).encode(encoding="utf-8")
    headers = {"Content-Type": "application/json"}
    response = requests.post(url=url, data=body, headers=headers).json()
    print(response)
    if response["code"] == 0:
        print("智能微秘书 推送成功！")
    else:
        print(f'智能微秘书 推送失败！{response["error"]}')


def smtp(title: str, content: str, **kwargs) -> None:
    """
    使用 SMTP 邮件 推送消息。
    """
    if not (
        (
            kwargs.get("SMTP_SERVER")
            and kwargs.get("SMTP_SSL")
            and kwargs.get("SMTP_EMAIL")
            and kwargs.get("SMTP_PASSWORD")
            and kwargs.get("SMTP_NAME")
        )
        or (
            push_config.get("SMTP_SERVER")
            and push_config.get("SMTP_SSL")
            and push_config.get("SMTP_EMAIL")
            and push_config.get("SMTP_PASSWORD")
            and push_config.get("SMTP_NAME")
        )
    ):
        print(
            "SMTP 邮件 的 SMTP_SERVER 或者 SMTP_SSL 或者 SMTP_EMAIL 或者 SMTP_PASSWORD 或者 SMTP_NAME 未设置!!\n取消推送"
        )
        return
    print("SMTP 邮件 服务启动")
    if (
        kwargs.get("SMTP_SERVER")
        and kwargs.get("SMTP_SSL")
        and kwargs.get("SMTP_EMAIL")
        and kwargs.get("SMTP_PASSWORD")
        and kwargs.get("SMTP_NAME")
    ):
        SMTP_SERVER = kwargs.get("SMTP_SERVER")
        SMTP_SSL = kwargs.get("SMTP_SSL")
        SMTP_EMAIL = kwargs.get("SMTP_EMAIL")
        SMTP_PASSWORD = kwargs.get("SMTP_PASSWORD")
        SMTP_NAME = kwargs.get("SMTP_NAME")
    else:
        SMTP_SERVER = push_config.get("SMTP_SERVER")
        SMTP_SSL = push_config.get("SMTP_SSL")
        SMTP_EMAIL = push_config.get("SMTP_EMAIL")
        SMTP_PASSWORD = push_config.get("SMTP_PASSWORD")
        SMTP_NAME = push_config.get("SMTP_NAME")

    message = MIMEText(content, "plain", "utf-8")
    message["From"] = formataddr(
        (
            Header(SMTP_NAME, "utf-8").encode(),
            SMTP_EMAIL,
        )
    )
    message["To"] = formataddr(
        (
            Header(SMTP_NAME, "utf-8").encode(),
            SMTP_EMAIL,
        )
    )
    message["Subject"] = Header(title, "utf-8")

    try:
        smtp_server = (
            smtplib.SMTP_SSL(SMTP_SERVER)
            if SMTP_SSL == "true"
            else smtplib.SMTP(SMTP_SERVER)
        )
        smtp_server.login(SMTP_EMAIL, SMTP_PASSWORD)
        smtp_server.sendmail(
            SMTP_EMAIL,
            SMTP_EMAIL,
            message.as_bytes(),
        )
        smtp_server.close()
        print("SMTP 邮件 推送成功！")
    except Exception as e:
        print(f"SMTP 邮件 推送失败！{e}")


def pushme(title: str, content: str, **kwargs) -> None:
    """
    使用 PushMe 推送消息。
    """
    if not (kwargs.get("PUSHME_KEY") or push_config.get("PUSHME_KEY")):
        print("PushMe 服务的 PUSHME_KEY 未设置!!\n取消推送")
        return
    print("PushMe 服务启动")
    PUSHME_KEY = kwargs.get("PUSHME_KEY", push_config.get("PUSHME_KEY"))

    url = f"https://push.i-i.me/?push_key={PUSHME_KEY}"
    data = {
        "title": title,
        "content": content,
    }
    response = requests.post(url, data=data)

    if response.status_code == 200 and response.text == "success":
        print("PushMe 推送成功！")
    else:
        print(f"PushMe 推送失败！{response.status_code} {response.text}")


def chronocat(title: str, content: str, **kwargs) -> None:
    """
    使用 CHRONOCAT 推送消息。
    """
    if not (
        (
            push_config.get("CHRONOCAT_URL")
            and push_config.get("CHRONOCAT_QQ")
            and push_config.get("CHRONOCAT_TOKEN")
        )
        or (
            push_config.get("CHRONOCAT_URL")
            and push_config.get("CHRONOCAT_QQ")
            and push_config.get("CHRONOCAT_TOKEN")
        )
    ):
        print("CHRONOCAT 服务的 CHRONOCAT_URL 或 CHRONOCAT_QQ 未设置!!\n取消推送")
        return
    print("CHRONOCAT 服务启动")
    if (
        kwargs.get("CHRONOCAT_URL")
        and kwargs.get("CHRONOCAT_QQ")
        and kwargs.get("CHRONOCAT_TOKEN")
    ):
        CHRONOCAT_URL = kwargs.get("CHRONOCAT_URL")
        CHRONOCAT_QQ = kwargs.get("CHRONOCAT_QQ")
        CHRONOCAT_TOKEN = kwargs.get("CHRONOCAT_TOKEN")
    else:
        CHRONOCAT_URL = push_config.get("CHRONOCAT_URL")
        CHRONOCAT_QQ = push_config.get("CHRONOCAT_QQ")
        CHRONOCAT_TOKEN = push_config.get("CHRONOCAT_TOKEN")

    user_ids = re.findall(r"user_id=(\d+)", CHRONOCAT_QQ)
    group_ids = re.findall(r"group_id=(\d+)", CHRONOCAT_QQ)

    url = f"{CHRONOCAT_URL}/api/message/send"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {CHRONOCAT_TOKEN}",
    }

    for chat_type, ids in [(1, user_ids), (2, group_ids)]:
        if not ids:
            continue
        for chat_id in ids:
            data = {
                "peer": {"chatType": chat_type, "peerUin": chat_id},
                "elements": [
                    {
                        "elementType": 1,
                        "textElement": {"content": f"{title}\n\n{content}"},
                    }
                ],
            }
            response = requests.post(url, headers=headers, data=json.dumps(data))
            if response.status_code == 200:
                if chat_type == 1:
                    print(f"QQ个人消息:{ids}推送成功！")
                else:
                    print(f"QQ群消息:{ids}推送成功！")
            else:
                if chat_type == 1:
                    print(f"QQ个人消息:{ids}推送失败！")
                else:
                    print(f"QQ群消息:{ids}推送失败！")


def parse_headers(headers):
    if not headers:
        return {}

    parsed = {}
    lines = headers.split("\n")

    for line in lines:
        i = line.find(":")
        if i == -1:
            continue

        key = line[:i].strip().lower()
        val = line[i + 1 :].strip()
        parsed[key] = parsed.get(key, "") + ", " + val if key in parsed else val

    return parsed


def parse_string(input_string, value_format_fn=None):
    matches = {}
    pattern = r"(\w+):\s*((?:(?!\n\w+:).)*)"
    regex = re.compile(pattern)
    for match in regex.finditer(input_string):
        key, value = match.group(1).strip(), match.group(2).strip()
        try:
            value = value_format_fn(value) if value_format_fn else value
            json_value = json.loads(value)
            matches[key] = json_value
        except:
            matches[key] = value
    return matches


def parse_body(body, content_type, value_format_fn=None):
    if not body or content_type == "text/plain":
        return body

    parsed = parse_string(input_string, value_format_fn)

    if content_type == "application/x-www-form-urlencoded":
        data = urlencode(parsed, doseq=True)
        return data

    if content_type == "application/json":
        data = json.dumps(parsed)
        return data

    return parsed


def format_notify_content(url, body, title, content):
    if "$title" not in url and "$title" not in body:
        return {}

    formatted_url = url.replace("$title", urllib.parse.quote_plus(title)).replace(
        "$content", urllib.parse.quote_plus(content)
    )
    formatted_body = body.replace("$title", title).replace("$content", content)

    return formatted_url, formatted_body


def custom_notify(title: str, content: str) -> None:
    """
    通过 自定义通知 推送消息。
    """
    if not push_config.get("WEBHOOK_URL") or not push_config.get("WEBHOOK_METHOD"):
        print("自定义通知的 WEBHOOK_URL 或 WEBHOOK_METHOD 未设置!!\n取消推送")
        return

    print("自定义通知服务启动")

    WEBHOOK_URL = push_config.get("WEBHOOK_URL")
    WEBHOOK_METHOD = push_config.get("WEBHOOK_METHOD")
    WEBHOOK_CONTENT_TYPE = push_config.get("WEBHOOK_CONTENT_TYPE")
    WEBHOOK_BODY = push_config.get("WEBHOOK_BODY")
    WEBHOOK_HEADERS = push_config.get("WEBHOOK_HEADERS")

    if "$title" not in WEBHOOK_URL and "$title" not in WEBHOOK_BODY:
        print("请求头或者请求体中必须包含 $title 和 $content")
        return

    headers = parse_headers(WEBHOOK_HEADERS)
    body = parse_body(
        WEBHOOK_BODY,
        WEBHOOK_CONTENT_TYPE,
        lambda v: v.replace("$title", title).replace("$content", content),
    )
    formatted_url = WEBHOOK_URL.replace(
        "$title", urllib.parse.quote_plus(title)
    ).replace("$content", urllib.parse.quote_plus(content))
    response = requests.request(
        method=WEBHOOK_METHOD, url=formatUrl, headers=headers, timeout=15, data=body
    )

    if response.status_code == 200:
        print("自定义通知推送成功！")
    else:
        print(f"自定义通知推送失败！{response.status_code} {response.text}")


def one() -> str:
    """
    获取一条一言。
    :return:
    """
    url = "https://v1.hitokoto.cn/"
    res = requests.get(url).json()
    return res["hitokoto"] + "    ----" + res["from"]


def add_notify_function():
    if push_config.get("BARK_PUSH"):
        notify_function.append(bark)
    if push_config.get("CONSOLE"):
        notify_function.append(console)
    if push_config.get("DD_BOT_TOKEN") and push_config.get("DD_BOT_SECRET"):
        notify_function.append(dingding_bot)
    if push_config.get("FSKEY"):
        notify_function.append(feishu_bot)
    if push_config.get("GOBOT_URL") and push_config.get("GOBOT_QQ"):
        notify_function.append(go_cqhttp)
    if push_config.get("GOTIFY_URL") and push_config.get("GOTIFY_TOKEN"):
        notify_function.append(gotify)
    if push_config.get("IGOT_PUSH_KEY"):
        notify_function.append(iGot)
    if push_config.get("PUSH_KEY"):
        notify_function.append(serverJ)
    if push_config.get("DEER_KEY"):
        notify_function.append(pushdeer)
    if push_config.get("CHAT_URL") and push_config.get("CHAT_TOKEN"):
        notify_function.append(chat)
    if push_config.get("PUSH_PLUS_TOKEN"):
        notify_function.append(pushplus_bot)
    if push_config.get("QMSG_KEY") and push_config.get("QMSG_TYPE"):
        notify_function.append(qmsg_bot)
    if push_config.get("QYWX_AM"):
        notify_function.append(wecom_app)
    if push_config.get("QYWX_KEY"):
        notify_function.append(wecom_bot)
    if push_config.get("TG_BOT_TOKEN") and push_config.get("TG_USER_ID"):
        notify_function.append(telegram_bot)
    if (
        push_config.get("AIBOTK_KEY")
        and push_config.get("AIBOTK_TYPE")
        and push_config.get("AIBOTK_NAME")
    ):
        notify_function.append(aibotk)
    if (
        push_config.get("SMTP_SERVER")
        and push_config.get("SMTP_SSL")
        and push_config.get("SMTP_EMAIL")
        and push_config.get("SMTP_PASSWORD")
        and push_config.get("SMTP_NAME")
    ):
        notify_function.append(smtp)
    if push_config.get("PUSHME_KEY"):
        notify_function.append(pushme)
    if (
        push_config.get("CHRONOCAT_URL")
        and push_config.get("CHRONOCAT_QQ")
        and push_config.get("CHRONOCAT_TOKEN")
    ):
        notify_function.append(chronocat)
    if push_config.get("WEBHOOK_URL") and push_config.get("WEBHOOK_METHOD"):
        notify_function.append(custom_notify)


def send(title: str, content: str, **kwargs) -> None:
    if not content:
        print(f"{title} 推送内容为空！")
        return

    # 根据标题跳过一些消息推送，环境变量：SKIP_PUSH_TITLE 用回车分隔
    skipTitle = os.getenv("SKIP_PUSH_TITLE")
    if skipTitle:
        if title in re.split("\n", skipTitle):
            print(f"{title} 在SKIP_PUSH_TITLE环境变量内，跳过推送！")
            return

    hitokoto = push_config.get("HITOKOTO")
    content += "\n\n" + one() if hitokoto else ""

    add_notify_function()
    ts = [
        threading.Thread(
            target=mode, args=(title, content), kwargs=kwargs, name=mode.__name__
        )
        for mode in notify_function
    ]
    [t.start() for t in ts]
    [t.join() for t in ts]


def main():
    send("title", "content")


if __name__ == "__main__":
    main()
