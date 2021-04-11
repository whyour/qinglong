import {
  FormOutlined,
  FieldTimeOutlined,
  DiffOutlined,
  SettingOutlined,
  CodeOutlined,
  FolderOutlined,
  RadiusSettingOutlined,
  ControlOutlined,
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
        path: '/crontab',
        name: '定时任务',
        icon: <FieldTimeOutlined />,
        component: '@/pages/crontab/index',
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
        icon: <ControlOutlined />,
        component: '@/pages/config/index',
      },
      {
        path: '/diy',
        name: '自定义脚本',
        icon: <FormOutlined />,
        component: '@/pages/diy/index',
      },
      {
        path: '/diff',
        name: '对比工具',
        icon: <DiffOutlined />,
        component: '@/pages/diff/index',
      },
      {
        path: '/log',
        name: '日志',
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
  location: {
    pathname: '/',
  },
  navTheme: 'light',
  fixSiderbar: true,
  contentWidth: 'Fixed',
  splitMenus: false,
  logo: logo,
} as any;
