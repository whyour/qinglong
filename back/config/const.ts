export const LOG_END_SYMBOL = '　　　　　';

export const TASK_COMMAND = 'task';
export const QL_COMMAND = 'ql';

export const TASK_PREFIX = `${TASK_COMMAND} `;
export const QL_PREFIX = `${QL_COMMAND} `;

export const SAMPLE_FILES = [
  {
    title: 'config.sample.sh',
    value: 'sample/config.sample.sh',
    target: 'config.sh',
  },
  {
    title: 'notify.js',
    value: 'sample/notify.js',
    target: 'data/scripts/sendNotify.js',
  },
  {
    title: 'notify.py',
    value: 'sample/notify.py',
    target: 'data/scripts/notify.py',
  },
];

export const PYTHON_INSTALL_DIR = process.env.PYTHON_HOME;

export const NotificationModeStringMap = {
  0: 'gotify',
  1: 'goCqHttpBot',
  2: 'serverChan',
  3: 'pushDeer',
  4: 'bark',
  5: 'chat',
  6: 'telegramBot',
  7: 'dingtalkBot',
  8: 'weWorkBot',
  9: 'weWorkApp',
  10: 'aibotk',
  11: 'iGot',
  12: 'pushPlus',
  13: 'wePlusBot',
  14: 'email',
  15: 'pushMe',
  16: 'feishu',
  17: 'webhook',
  18: 'chronocat',
  19: 'ntfy',
  20: 'wxPusherBot',
} as const;
