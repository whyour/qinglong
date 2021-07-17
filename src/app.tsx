import { history } from 'umi';
import { request } from '@/utils/http';
import config from '@/utils/config';

const titleMap: any = {
  '/': '控制面板',
  '/login': '登录',
  '/crontab': '定时任务',
  '/env': '环境变量',
  '/config': '配置文件',
  '/script': '脚本管理',
  '/diff': '对比工具',
  '/log': '任务日志',
  '/setting': '系统设置',
};

export function render(oldRender: any) {
  request
    .get(`${config.apiPrefix}user`)
    .then((data) => {
      if (data.data && data.data.username) {
        return oldRender();
      }
      localStorage.removeItem(config.authKey);
      history.push('/login');
      oldRender();
    })
    .catch((e) => {
      if (e.response && e.response.status === 401) {
        localStorage.removeItem(config.authKey);
        history.push('/login');
        oldRender();
      }
    });
}

export function onRouteChange({ matchedRoutes }: any) {
  if (matchedRoutes.length) {
    const path: string = matchedRoutes[matchedRoutes.length - 1].route.path;
    document.title = `${titleMap[path]} - 控制面板`;
  }
}
