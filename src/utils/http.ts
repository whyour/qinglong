import { extend } from 'umi-request';
import { message } from 'antd';
import config from './config';
import { history } from 'umi';

message.config({
  duration: 1.5,
});

const time = Date.now();
const errorHandler = function (error: any) {
  if (error.response) {
    const msg = error.data
      ? error.data.message || error.data
      : error.response.statusText;
    const responseStatus = error.response.status;
    if (responseStatus === 502) {
      message.error('服务异常，请手动执行ql check检查服务状态');
    } else if (responseStatus === 401) {
      if (history.location.pathname !== '/login') {
        message.error('登录已过期，请重新登录');
        localStorage.removeItem(config.authKey);
        history.push('/login');
      }
    } else {
      message.error(msg);
    }
  } else {
    console.log(error.message);
  }

  throw error; // 如果throw. 错误将继续抛出.
};

const _request = extend({ timeout: 60000, params: { t: time }, errorHandler });
const apiWhiteList = [
  '/api/login',
  '/open/auth/token',
  '/api/user/two-factor/login',
  '/api/system',
  '/api/init/user',
  '/api/init/notification',
];

_request.interceptors.request.use((url, options) => {
  const token = localStorage.getItem(config.authKey);
  if (token && !apiWhiteList.includes(url)) {
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    return { url, options: { ...options, headers } };
  }
  return { url, options };
});

_request.interceptors.response.use(async (response) => {
  const res = await response.clone();
  return response;
});

export const request = _request;
