import intl from 'react-intl-universal';
import { SettingOutlined } from '@ant-design/icons';
import IconFont from '@/components/iconfont';
import { BasicLayoutProps } from '@ant-design/pro-layout';

export default {
  route: {
    routes: [
      {
        name: intl.get('登录'),
        path: '/login',
        hideInMenu: true,
        component: '@/pages/login/index',
      },
      {
        name: intl.get('初始化'),
        path: '/initialization',
        hideInMenu: true,
        component: '@/pages/initialization/index',
      },
      {
        name: intl.get('错误'),
        path: '/error',
        hideInMenu: true,
        component: '@/pages/error/index',
      },
      {
        path: '/crontab',
        name: intl.get('定时任务'),
        icon: <IconFont type="ql-icon-crontab" />,
        component: '@/pages/crontab/index',
      },
      {
        path: '/subscription',
        name: intl.get('订阅管理'),
        icon: <IconFont type="ql-icon-subs" />,
        component: '@/pages/subscription/index',
      },
      {
        path: '/env',
        name: intl.get('环境变量'),
        icon: <IconFont type="ql-icon-env" />,
        component: '@/pages/env/index',
      },
      {
        path: '/config',
        name: intl.get('配置文件'),
        icon: <IconFont type="ql-icon-config" />,
        component: '@/pages/config/index',
      },
      {
        path: '/script',
        name: intl.get('脚本管理'),
        icon: <IconFont type="ql-icon-script" />,
        component: '@/pages/script/index',
      },
      {
        path: '/dependence',
        name: intl.get('依赖管理'),
        icon: <IconFont type="ql-icon-dependence" />,
        component: '@/pages/dependence/index',
      },
      {
        path: '/log',
        name: intl.get('日志管理'),
        icon: <IconFont type="ql-icon-log" />,
        component: '@/pages/log/index',
      },
      {
        path: '/diff',
        name: intl.get('对比工具'),
        icon: <IconFont type="ql-icon-diff" />,
        component: '@/pages/diff/index',
      },
      {
        path: '/setting',
        name: intl.get('系统设置'),
        icon: <SettingOutlined />,
        component: '@/pages/password/index',
      },
    ],
  },
  navTheme: 'light',
  fixSiderbar: true,
  contentWidth: 'Fixed',
  splitMenus: false,
  siderWidth: 180,
} as BasicLayoutProps;
