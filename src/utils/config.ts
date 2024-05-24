import intl from 'react-intl-universal';
const baseUrl = window.__ENV__QlBaseUrl || '/';

export default {
  siteName: intl.get('青龙'),
  baseUrl,
  apiPrefix: `${baseUrl}api/`,
  authKey: 'token',

  /* Layout configuration, specify which layout to use for route. */
  layouts: [
    {
      name: 'primary',
      include: [/.*/],
      exclude: [/(\/(en|zh))*\/login/],
    },
  ],

  /* I18n configuration, `languages` and `defaultLanguage` are required currently. */
  i18n: {
    /* Countrys flags: https://www.flaticon.com/packs/countrys-flags */
    languages: [
      {
        key: 'pt-br',
        title: 'Português',
        flag: '/portugal.svg',
      },
      {
        key: 'en',
        title: 'English',
        flag: '/america.svg',
      },
      {
        key: 'zh',
        title: intl.get('中文'),
        flag: '/china.svg',
      },
    ],
    defaultLanguage: 'en',
  },
  scopes: [
    {
      name: intl.get('定时任务'),
      value: 'crons',
    },
    {
      name: intl.get('环境变量'),
      value: 'envs',
    },
    {
      name: intl.get('订阅管理'),
      value: 'subscriptions',
    },
    {
      name: intl.get('配置文件'),
      value: 'configs',
    },
    {
      name: intl.get('脚本管理'),
      value: 'scripts',
    },
    {
      name: intl.get('日志管理'),
      value: 'logs',
    },
    {
      name: intl.get('依赖管理'),
      value: 'dependencies',
    },
    {
      name: intl.get('系统信息'),
      value: 'system',
    },
  ],
  scopesMap: {
    crons: intl.get('定时任务'),
    envs: intl.get('环境变量'),
    subscriptions: intl.get('订阅管理'),
    configs: intl.get('配置文件'),
    scripts: intl.get('脚本管理'),
    logs: intl.get('日志管理'),
    dependencies: intl.get('依赖管理'),
    system: intl.get('系统信息'),
  },
  notificationModes: [
    { value: 'gotify', label: 'Gotify' },
    { value: 'goCqHttpBot', label: 'GoCqHttpBot' },
    { value: 'serverChan', label: intl.get('Server酱') },
    { value: 'pushDeer', label: 'PushDeer' },
    { value: 'bark', label: 'Bark' },
    { value: 'telegramBot', label: intl.get('Telegram机器人') },
    { value: 'dingtalkBot', label: intl.get('钉钉机器人') },
    { value: 'weWorkBot', label: intl.get('企业微信机器人') },
    { value: 'weWorkApp', label: intl.get('企业微信应用') },
    { value: 'aibotk', label: intl.get('智能微秘书') },
    { value: 'iGot', label: 'IGot' },
    { value: 'pushPlus', label: 'PushPlus' },
    { value: 'wePlusBot', label: intl.get('微加机器人') },
    { value: 'chat', label: intl.get('群晖chat') },
    { value: 'email', label: intl.get('邮箱') },
    { value: 'lark', label: intl.get('飞书机器人') },
    { value: 'pushMe', label: 'PushMe' },
    { value: 'chronocat', label: 'Chronocat' },
    { value: 'webhook', label: intl.get('自定义通知') },
    { value: 'closed', label: intl.get('已关闭') },
  ],
  notificationModeMap: {
    gotify: [
      {
        label: 'gotifyUrl',
        tip: intl.get('gotify的url地址，例如 https://push.example.de:8080'),
        required: true,
      },
      {
        label: 'gotifyToken',
        tip: intl.get('gotify的消息应用token码'),
        required: true,
      },
      { label: 'gotifyPriority', tip: intl.get('推送消息的优先级') },
    ],
    chat: [
      {
        label: 'chatUrl',
        tip: intl.get('chat的url地址'),
        required: true,
      },
      { label: 'chatToken', tip: intl.get('chat的token码'), required: true },
    ],
    goCqHttpBot: [
      {
        label: 'goCqHttpBotUrl',
        tip: intl.get(
          '推送到个人QQ: http://127.0.0.1/send_private_msg，群：http://127.0.0.1/send_group_msg',
        ),
        required: true,
      },
      { label: 'goCqHttpBotToken', tip: intl.get('访问密钥'), required: true },
      {
        label: 'goCqHttpBotQq',
        tip: intl.get(
          '如果GOBOT_URL设置 /send_private_msg 则需要填入 user_id=个人QQ 相反如果是 /send_group_msg 则需要填入 group_id=QQ群',
        ),
        required: true,
      },
    ],
    serverChan: [
      {
        label: 'serverChanKey',
        tip: intl.get('Server酱SENDKEY'),
        required: true,
      },
    ],
    pushDeer: [
      {
        label: 'pushDeerKey',
        tip: intl.get('PushDeer的Key，https://github.com/easychen/pushdeer'),
        required: true,
      },
      {
        label: 'pushDeerUrl',
        tip: intl.get(
          'PushDeer的自架API endpoint，默认是 https://api2.pushdeer.com/message/push',
        ),
      },
    ],
    bark: [
      {
        label: 'barkPush',
        tip: intl.get(
          'Bark的信息IP/设备码，例如：https://api.day.app/XXXXXXXX',
        ),
        required: true,
      },
      {
        label: 'barkIcon',
        tip: intl.get('BARK推送图标，自定义推送图标 (需iOS15或以上才能显示)'),
      },
      {
        label: 'barkSound',
        tip: intl.get('BARK推送铃声，铃声列表去APP查看复制填写'),
      },
      {
        label: 'barkGroup',
        tip: intl.get('BARK推送消息的分组，默认为qinglong'),
      },
      {
        label: 'barkLevel',
        tip: intl.get('BARK推送消息的时效性，默认为active'),
      },
      {
        label: 'barkUrl',
        tip: intl.get('BARK推送消息的跳转URL'),
      },
      {
        label: 'barkArchive',
        tip: intl.get('BARK是否保存推送消息'),
      },
    ],
    telegramBot: [
      {
        label: 'telegramBotToken',
        tip: intl.get(
          'telegram机器人的token，例如：1077xxx4424:AAFjv0FcqxxxxxxgEMGfi22B4yh15R5uw',
        ),
        required: true,
      },
      {
        label: 'telegramBotUserId',
        tip: intl.get('telegram用户的id，例如：129xxx206'),
        required: true,
      },
      { label: 'telegramBotProxyHost', tip: intl.get('代理IP') },
      { label: 'telegramBotProxyPort', tip: intl.get('代理端口') },
      {
        label: 'telegramBotProxyAuth',
        tip: intl.get(
          'telegram代理配置认证参数，用户名与密码用英文冒号连接 user:password',
        ),
      },
      {
        label: 'telegramBotApiHost',
        tip: intl.get('telegram api自建的反向代理地址，默认tg官方api'),
      },
    ],
    dingtalkBot: [
      {
        label: 'dingtalkBotToken',
        tip: intl.get(
          '钉钉机器人webhook token，例如：5a544165465465645d0f31dca676e7bd07415asdasd',
        ),
        required: true,
      },
      {
        label: 'dingtalkBotSecret',
        tip: intl.get(
          '密钥，机器人安全设置页面，加签一栏下面显示的SEC开头的字符串',
        ),
      },
    ],
    weWorkBot: [
      {
        label: 'weWorkBotKey',
        tip: intl.get(
          '企业微信机器人的webhook(详见文档 https://work.weixin.qq.com/api/doc/90000/90136/91770)，例如：693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa',
        ),
        required: true,
      },
      {
        label: 'weWorkOrigin',
        tip: intl.get('企业微信代理地址'),
      },
    ],
    weWorkApp: [
      {
        label: 'weWorkAppKey',
        tip: intl.get(
          'corpid、corpsecret、touser(注:多个成员ID使用|隔开)、agentid、消息类型(选填，不填默认文本消息类型) 注意用,号隔开(英文输入法的逗号)，例如：wwcfrs,B-76WERQ,qinglong,1000001,2COat',
        ),
        required: true,
      },
      {
        label: 'weWorkOrigin',
        tip: intl.get('企业微信代理地址'),
      },
    ],
    aibotk: [
      {
        label: 'aibotkKey',
        tip: intl.get(
          '密钥key，智能微秘书个人中心获取apikey，申请地址：https://wechat.aibotk.com/signup?from=ql',
        ),
        required: true,
      },
      {
        label: 'aibotkType',
        tip: intl.get('发送的目标，群组或者好友'),
        required: true,
        placeholder: intl.get('请输入要发送的目标'),
        items: [
          { value: 'room', label: intl.get('群聊') },
          { value: 'contact', label: intl.get('好友') },
        ],
      },
      {
        label: 'aibotkName',
        tip: intl.get(
          '要发送的用户昵称或群名，如果目标是群，需要填群名，如果目标是好友，需要填好友昵称',
        ),
        required: true,
      },
    ],
    iGot: [
      {
        label: 'iGotPushKey',
        tip: intl.get(
          'iGot的信息推送key，例如：https://push.hellyw.com/XXXXXXXX',
        ),
        required: true,
      },
    ],
    pushPlus: [
      {
        label: 'pushPlusToken',
        tip: intl.get(
          '微信扫码登录后一对一推送或一对多推送下面的token(您的Token)，不提供PUSH_PLUS_USER则默认为一对一推送，参考 https://www.pushplus.plus/',
        ),
        required: true,
      },
      {
        label: 'pushPlusUser',
        tip: intl.get(
          '一对多推送的“群组编码”（一对多推送下面->您的群组(如无则创建)->群组编码，如果您是创建群组人。也需点击“查看二维码”扫描绑定，否则不能接受群组消息推送）',
        ),
      },
    ],
    wePlusBot: [
      {
        label: 'wePlusBotToken',
        tip: intl.get(
          '用户令牌，扫描登录后 我的—>设置->令牌 中获取，参考 https://www.weplusbot.com/',
        ),
        required: true,
      },
      {
        label: 'wePlusBotReceiver',
        tip: intl.get(
          '消息接收人',
        ),
      },
      {
        label: 'wePlusBotVersion',
        tip: intl.get(
          '调用版本；专业版填写pro，个人版填写personal，为空默认使用专业版',
        ),
      },
    ],
    lark: [
      {
        label: 'larkKey',
        tip: intl.get(
          '飞书群组机器人：https://www.feishu.cn/hc/zh-CN/articles/360024984973',
        ),
        required: true,
      },
    ],
    email: [
      {
        label: 'emailService',
        tip: intl.get(
          '邮箱服务名称，比如126、163、Gmail、QQ等，支持列表https://github.com/nodemailer/nodemailer/blob/master/lib/well-known/services.json',
        ),
        required: true,
      },
      { label: 'emailUser', tip: intl.get('邮箱地址'), required: true },
      { label: 'emailPass', tip: intl.get('SMTP 登录密码，也可能为特殊口令，视具体邮件服务商说明而定'), required: true },
    ],
    pushMe: [
      {
        label: 'pushMeKey',
        tip: intl.get('PushMe的Key，https://push.i-i.me/'),
        required: true,
      },
      {
        label: 'pushMeUrl',
        tip: intl.get('自建的PushMeServer消息接口地址，例如：http://127.0.0.1:3010，不填则使用官方消息接口'),
        required: false,
      },
    ],
    chronocat: [
      {
        label: 'chronocatURL',
        tip: intl.get(
          'Chronocat Red 服务的连接地址 https://chronocat.vercel.app/install/docker/official/',
        ),
        required: true,
      },
      {
        label: 'chronocatQQ',
        tip: intl.get(
          '个人:user_id=个人QQ 群则填入group_id=QQ群 多个用英文;隔开同时支持个人和群 如：user_id=xxx;group_id=xxxx;group_id=xxxxx',
        ),
        required: true,
      },
      {
        label: 'chronocatToken',
        tip: intl.get(
          'docker安装在持久化config目录下的chronocat.yml文件可找到',
        ),
        required: true,
      },
    ],
    webhook: [
      {
        label: 'webhookMethod',
        tip: intl.get('请求方法'),
        required: true,
        items: [{ value: 'GET' }, { value: 'POST' }, { value: 'PUT' }],
      },
      {
        label: 'webhookContentType',
        tip: intl.get('请求头Content-Type'),
        required: true,
        items: [
          { value: 'text/plain' },
          { value: 'application/json' },
          { value: 'multipart/form-data' },
          { value: 'application/x-www-form-urlencoded' },
        ],
      },
      {
        label: 'webhookUrl',
        tip: intl.get(
          '请求链接以http或者https开头。url或者body中必须包含$title，$content可选，对应api内容的位置',
        ),
        required: true,
        placeholder: 'https://xxx.cn/api?content=$title\n',
      },
      {
        label: 'webhookHeaders',
        tip: intl.get('请求头格式Custom-Header1: Header1，多个换行分割'),
        placeholder: 'Custom-Header1: Header1\nCustom-Header2: Header2',
      },
      {
        label: 'webhookBody',
        tip: intl.get(
          '请求体格式key1: value1，多个换行分割。url或者body中必须包含$title，$content可选，对应api内容的位置',
        ),
        placeholder: 'key1: $title\nkey2: $content',
      },
    ],
  },
  documentTitleMap: {
    '/login': intl.get('登录'),
    '/initialization': intl.get('初始化'),
    '/crontab': intl.get('定时任务'),
    '/env': intl.get('环境变量'),
    '/subscription': intl.get('订阅管理'),
    '/config': intl.get('配置文件'),
    '/script': intl.get('脚本管理'),
    '/diff': intl.get('对比工具'),
    '/log': intl.get('日志管理'),
    '/setting': intl.get('系统设置'),
    '/error': intl.get('错误日志'),
    '/dependence': intl.get('依赖管理'),
  },
  dependenceTypes: ['nodejs', 'python3', 'linux'],
};
