import { history } from 'umi';
import { request } from '@/utils/http';
import config from '@/utils/config';

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
      console.log(e);
      if (e.response && e.response.status === 401) {
        localStorage.removeItem(config.authKey);
        history.push('/login');
        oldRender();
      }
    });
}
