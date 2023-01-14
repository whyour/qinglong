import {
  FormOutlined,
  FieldTimeOutlined,
  DiffOutlined,
  SettingOutlined,
  CodeOutlined,
  FolderOutlined,
  RadiusSettingOutlined,
  ControlOutlined,
  ContainerOutlined,
} from '@ant-design/icons';
import IconFont from '@/components/iconfont';
import { BasicLayoutProps } from '@ant-design/pro-layout';

export default {
  route: {
    routes: [
      {
        name: '登录',
        path: '/login',
        hideInMenu: true,
        component: '@/pages/login/index',
      },
      {
        name: '初始化',
        path: '/initialization',
        hideInMenu: true,
        component: '@/pages/initialization/index',
      },
      {
        name: '错误',
        path: '/error',
        hideInMenu: true,
        component: '@/pages/error/index',
      },
      {
        path: '/crontab',
        name: '定时任务',
        icon: <IconFont type="ql-icon-crontab" />,
        component: '@/pages/crontab/index',
      },
      {
        path: '/subscription',
        name: '订阅管理',
        icon: <IconFont type="ql-icon-subs" />,
        component: '@/pages/subscription/index',
      },
      {
        path: '/env',
        name: '环境变量',
        icon: <IconFont type="ql-icon-env" />,
        component: '@/pages/env/index',
      },
      {
        path: '/config',
        name: '配置文件',
        icon: <IconFont type="ql-icon-config" />,
        component: '@/pages/config/index',
      },
      {
        path: '/script',
        name: '脚本管理',
        icon: <IconFont type="ql-icon-script" />,
        component: '@/pages/script/index',
      },
      {
        path: '/dependence',
        name: '依赖管理',
        icon: <IconFont type="ql-icon-dependence" />,
        component: '@/pages/dependence/index',
      },
      {
        path: '/log',
        name: '日志管理',
        icon: <IconFont type="ql-icon-log" />,
        component: '@/pages/log/index',
      },
      {
        path: '/diff',
        name: '对比工具',
        icon: <IconFont type="ql-icon-diff" />,
        component: '@/pages/diff/index',
      },
      {
        path: '/setting',
        name: '系统设置',
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
