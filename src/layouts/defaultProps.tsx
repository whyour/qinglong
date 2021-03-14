import {
  FormOutlined,
  FieldTimeOutlined,
  DiffOutlined,
  SettingOutlined,
  CodeOutlined,
  FolderOutlined,
  LockOutlined,
  RadiusSettingOutlined,
} from '@ant-design/icons';
import logo from '@/assets/logo.png';

export default {
  route: {
    routes: [
      {
        name: 'login',
        path: '/login',
        hideInMenu: true,
        component: '@/pages/login/index',
      },
      {
        path: '/cookie',
        name: 'Cookie管理',
        icon: <RadiusSettingOutlined />,
        component: '@/pages/cookie/index',
      },
      {
        path: '/config',
        name: '配置文件',
        icon: <SettingOutlined />,
        component: '@/pages/config/index',
      },
      {
        path: '/diy',
        name: '自定义脚本',
        icon: <FormOutlined />,
        component: '@/pages/diy/index',
      },
      {
        path: '/crontab',
        name: '定时任务',
        icon: <FieldTimeOutlined />,
        component: '@/pages/crontab/index',
      },
      {
        path: '/diff',
        name: '对比工具',
        icon: <DiffOutlined />,
        component: '@/pages/diff/index',
      },
      {
        path: '/code',
        name: '互助码',
        icon: <CodeOutlined />,
        component: '@/pages/code/index',
      },
      {
        path: '/log',
        name: '日志',
        icon: <FolderOutlined />,
        component: '@/pages/log/index',
      },
      {
        path: '/password',
        name: '修改密码',
        icon: <LockOutlined />,
        component: '@/pages/password/index',
      },
    ],
  },
  location: {
    pathname: '/',
  },
  fixSiderbar: true,
  navTheme: 'light',
  primaryColor: '#1890ff',
  contentWidth: 'Fixed',
  splitMenus: false,
  logo: logo,
} as any;
