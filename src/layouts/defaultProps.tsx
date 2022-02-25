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
        icon: <FieldTimeOutlined />,
        component: '@/pages/crontab/index',
      },
      {
        path: '/env',
        name: '环境变量',
        icon: <RadiusSettingOutlined />,
        component: '@/pages/env/index',
      },
      {
        path: '/config',
        name: '配置文件',
        icon: <ControlOutlined />,
        component: '@/pages/config/index',
      },
      {
        path: '/script',
        name: '脚本管理',
        icon: <FormOutlined />,
        component: '@/pages/script/index',
      },
      {
        path: '/dependence',
        name: '依赖管理',
        icon: <ContainerOutlined />,
        component: '@/pages/dependence/index',
      },
      {
        path: '/diff',
        name: '对比工具',
        icon: <DiffOutlined />,
        component: '@/pages/diff/index',
      },
      {
        path: '/log',
        name: '任务日志',
        icon: <FolderOutlined />,
        component: '@/pages/log/index',
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
} as any;
