import requests
import datetime
import time
import json
from datetime import timedelta
from datetime import timezone
from .utils import cookies
SHA_TZ = timezone(
    timedelta(hours=8),
    name='Asia/Shanghai',
)


session = requests.session()


url = "https://api.m.jd.com/api"


def getbody(page):
    body = {
        "beginDate": datetime.datetime.utcnow().replace(tzinfo=timezone.utc).astimezone(SHA_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "endDate": datetime.datetime.utcnow().replace(tzinfo=timezone.utc).astimezone(SHA_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "pageNo": page,
        "pageSize": 20,
    }
    return body


def getparms(page):
    body = getbody(page)
    parms = {
        "functionId": "jposTradeQuery",
        "appid": "swat_miniprogram",
        "client": "tjj_m",
        "sdkName": "orderDetail",
        "sdkVersion": "1.0.0",
        "clientVersion": "3.1.3",
        "timestamp": int(round(time.time() * 1000)),
        "body": json.dumps(body)
    }
    return parms


def getbeans(ck):
    _7day = True
    page = 0
    headers = {
        "Host": "api.m.jd.com",
        "Connection": "keep-alive",
        "charset": "utf-8",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 9 Build/QKQ1.190825.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.62 XWEB/2797 MMWEBSDK/201201 Mobile Safari/537.36 MMWEBID/7986 MicroMessenger/8.0.1840(0x2800003B) Process/appbrand4 WeChat/arm64 Weixin NetType/4G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "Content-Type": "application/x-www-form-urlencoded;",
        "Accept-Encoding": "gzip, compress, deflate, br",
        "Cookie": ck,
        "Referer": "https://servicewechat.com/wxa5bf5ee667d91626/141/page-frame.html",
    }
    _7days = []
    for i in range(0, 7):
        _7days.append(
            (datetime.date.today() - datetime.timedelta(days=i)).strftime("%Y-%m-%d"))
    beansin = {key: 0 for key in _7days}
    beansout = {key: 0 for key in _7days}
    while _7day:
        page = page + 1
        resp = session.get(url, params=getparms(page), headers=headers).text
        res = json.loads(resp)
        if res['resultCode'] == 0:
            for i in res['data']['list']:
                for date in _7days:
                    if str(date) in i['createDate'] and i['amount'] > 0:
                        beansin[str(date)] = beansin[str(date)] + i['amount']
                        break
                    elif str(date) in i['createDate'] and i['amount'] < 0:
                        beansout[str(date)] = beansout[str(date)] + i['amount']
                        break
                if i['createDate'].split(' ')[0] not in str(_7days):
                    _7day = False
        else:
            return 'error' + str(res), None, None
    return beansin, beansout, _7days


def getTotal(ck):
    headers = {
        "Host": "wxapp.m.jd.com",
        "Connection": "keep-alive",
        "charset": "utf-8",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 9 Build/QKQ1.190825.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.62 XWEB/2797 MMWEBSDK/201201 Mobile Safari/537.36 MMWEBID/7986 MicroMessenger/8.0.1840(0x2800003B) Process/appbrand4 WeChat/arm64 Weixin NetType/4G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "Content-Type": "application/x-www-form-urlencoded;",
        "Accept-Encoding": "gzip, compress, deflate, br",
        "Cookie": ck,
    }
    jurl = "https://wxapp.m.jd.com/kwxhome/myJd/home.json"
    resp = session.get(jurl, headers=headers).text
    res = json.loads(resp)
    return res['user']['jingBean']


def get_bean_data(i):
    ck = cookies[i-1]
    beansin, beansout, _7days = getbeans(ck)
    beantotal = getTotal(ck)
    if not beansout:
        return str(beansin), None, None,None
    else:
        beanin, beanout = [], []
        beanstotal = [int(beantotal), ]
        for i in beansin:
            beantotal = int(beantotal) - int(beansin[i]) - int(beansout[i])
            beanin.append(beansin[i])
            beanout.append(int(str(beansout[i]).replace('-', '')))
            beanstotal.append(beantotal)
        return beanin[::-1], beanout[::-1], beanstotal[::-1], _7days[::-1]
