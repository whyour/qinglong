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

export const LINUX_DEPENDENCE_COMMAND: Record<
  'Debian' | 'Ubuntu' | 'Alpine',
  {
    install: string;
    uninstall: string;
    info: string;
    check(info: string): boolean;
  }
> = {
  Debian: {
    install: 'apt-get install -y',
    uninstall: 'apt-get remove -y',
    info: 'dpkg-query -s',
    check(info: string) {
      return info.includes('install ok installed');
    },
  },
  Ubuntu: {
    install: 'apt-get install -y',
    uninstall: 'apt-get remove -y',
    info: 'dpkg-query -s',
    check(info: string) {
      return info.includes('install ok installed');
    },
  },
  Alpine: {
    install: 'apk add --no-check-certificate',
    uninstall: 'apk del',
    info: 'apk info -es',
    check(info: string) {
      return info.includes('installed');
    },
  },
};
