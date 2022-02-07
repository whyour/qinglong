export default {
  siteName: '青龙控制面板',
  apiPrefix: '/api/',
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
        title: '中文',
        flag: '/china.svg',
      },
    ],
    defaultLanguage: 'en',
  },
  scopes: [
    {
      name: '定时任务',
      value: 'crons',
    },
    {
      name: '环境变量',
      value: 'envs',
    },
    {
      name: '配置文件',
      value: 'configs',
    },
    {
      name: '脚本管理',
      value: 'scripts',
    },
    {
      name: '任务日志',
      value: 'logs',
    },
    {
      name: '依赖管理',
      value: 'dependencies',
    },
    {
      name: '系统信息',
      value: 'system',
    },
  ],
  scopesMap: {
    crons: '定时任务',
    envs: '环境变量',
    configs: '配置文件',
    scripts: '脚本管理',
    logs: '任务日志',
    dependencies: '依赖管理',
    system: '系统信息',
  },
  notificationModes: [
    { value: 'gotify', label: 'Gotify' },
    { value: 'goCqHttpBot', label: 'GoCqHttpBot' },
    { value: 'serverChan', label: 'Server酱' },
    { value: 'bark', label: 'Bark' },
    { value: 'telegramBot', label: 'Telegram机器人' },
    { value: 'dingtalkBot', label: '钉钉机器人' },
    { value: 'weWorkBot', label: '企业微信机器人' },
    { value: 'weWorkApp', label: '企业微信应用' },
    { value: 'iGot', label: 'IGot' },
    { value: 'pushPlus', label: 'PushPlus' },
    { value: 'email', label: '邮箱' },
    { value: 'closed', label: '已关闭' },
  ],
  notificationModeMap: {
    gotify: [
      {
        label: 'gotifyUrl',
        tip: 'gotify的url地址,例如 https://push.example.de:8080',
        required: true,
      },
      { label: 'gotifyToken', tip: 'gotify的消息应用token码', required: true },
      { label: 'gotifyPriority', tip: '推送消息的优先级' },
    ],
    goCqHttpBot: [
      {
        label: 'goCqHttpBotUrl',
        tip: '推送到个人QQ: http://127.0.0.1/send_private_msg，群：http://127.0.0.1/send_group_msg',
        required: true,
      },
      { label: 'goCqHttpBotToken', tip: '访问密钥', required: true },
      {
        label: 'goCqHttpBotQq',
        tip: '如果GOBOT_URL设置 /send_private_msg 则需要填入 user_id=个人QQ 相反如果是 /send_group_msg 则需要填入 group_id=QQ群',
        required: true,
      },
    ],
    serverChan: [
      { label: 'serverChanKey', tip: 'Server酱SENDKEY', required: true },
    ],
    bark: [
      {
        label: 'barkPush',
        tip: 'Bark的信息IP/设备码，例如：https://api.day.app/XXXXXXXX',
        required: true,
      },
      { label: 'barkIcon', tip: 'BARK推送图标,自定义推送图标 (需iOS15或以上才能显示)' },
      { label: 'barkSound', tip: 'BARK推送铃声,铃声列表去APP查看复制填写' },
      { label: 'barkGroup', tip: 'BARK推送消息的分组, 默认为qinglong' },
    ],
    telegramBot: [
      {
        label: 'telegramBotToken',
        tip: 'telegram机器人的token，例如：1077xxx4424:AAFjv0FcqxxxxxxgEMGfi22B4yh15R5uw',
        required: true,
      },
      {
        label: 'telegramBotUserId',
        tip: 'telegram用户的id，例如：129xxx206',
        required: true,
      },
      { label: 'telegramBotProxyHost', tip: '代理IP' },
      { label: 'telegramBotProxyPort', tip: '代理端口' },
      {
        label: 'telegramBotProxyAuth',
        tip: 'telegram代理配置认证参数, 用户名与密码用英文冒号连接 user:password',
      },
      {
        label: 'telegramBotApiHost',
        tip: 'telegram api自建的反向代理地址，默认tg官方api',
      },
    ],
    dingtalkBot: [
      {
        label: 'dingtalkBotToken',
        tip: '钉钉机器人webhook token，例如：5a544165465465645d0f31dca676e7bd07415asdasd',
        required: true,
      },
      {
        label: 'dingtalkBotSecret',
        tip: '密钥，机器人安全设置页面，加签一栏下面显示的SEC开头的字符串',
      },
    ],
    weWorkBot: [
      {
        label: 'weWorkBotKey',
        tip: '企业微信机器人的 webhook(详见文档 https://work.weixin.qq.com/api/doc/90000/90136/91770)，例如：693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa',
        required: true,
      },
    ],
    weWorkApp: [
      {
        label: 'weWorkAppKey',
        tip: 'corpid,corpsecret,touser(注:多个成员ID使用|隔开),agentid,消息类型(选填,不填默认文本消息类型) 注意用,号隔开(英文输入法的逗号)，例如：wwcfrs,B-76WERQ,qinglong,1000001,2COat',
        required: true,
      },
    ],
    iGot: [
      {
        label: 'iGotPushKey',
        tip: 'iGot的信息推送key，例如：https://push.hellyw.com/XXXXXXXX',
        required: true,
      },
    ],
    pushPlus: [
      {
        label: 'pushPlusToken',
        tip: '微信扫码登录后一对一推送或一对多推送下面的token(您的Token)，不提供PUSH_PLUS_USER则默认为一对一推送',
        required: true,
      },
      {
        label: 'pushPlusUser',
        tip: '一对多推送的“群组编码”（一对多推送下面->您的群组(如无则新建)->群组编码，如果您是创建群组人。也需点击“查看二维码”扫描绑定，否则不能接受群组消息推送）',
      },
    ],
    email: [
      {
        label: 'emailService',
        tip: '邮箱服务名称，比如126、163、Gmail、QQ等，支持列表https://nodemailer.com/smtp/well-known/',
        required: true,
      },
      { label: 'emailUser', tip: '邮箱地址', required: true },
      { label: 'emailPass', tip: '邮箱SMTP授权码', required: true },
    ],
  },
  documentTitleMap: {
    '/login': '登录',
    '/initialization': '初始化',
    '/cron': '定时任务',
    '/env': '环境变量',
    '/config': '配置文件',
    '/script': '脚本管理',
    '/diff': '对比工具',
    '/log': '任务日志',
    '/setting': '系统设置',
  },
  dependenceTypes: ['nodejs', 'python3', 'linux'],
};
