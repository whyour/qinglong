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
  ],
  scopesMap: {
    crons: '定时任务',
    envs: '环境变量',
    configs: '配置文件',
    scripts: '脚本管理',
    logs: '任务日志',
  },
};
