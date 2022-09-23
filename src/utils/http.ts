import { extend } from 'umi-request';
import { message } from 'antd';
import config from './config';
import { history } from '@umijs/max';

message.config({
  duration: 1.5,
});

const time = Date.now();
const errorHandler = function (error: any) {
  if (error.response) {
    const msg = error.data
      ? error.data.message || error.message || error.data
      : error.response.statusText;
    const responseStatus = error.response.status;
    if ([502, 504].includes(responseStatus)) {
      history.push('/error');
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
  '/api/user/login',
  '/open/auth/token',
  '/api/user/two-factor/login',
  '/api/system',
  '/api/user/init',
  '/api/user/notification/init',
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
  const responseStatus = response.status;
  if ([502, 504].includes(responseStatus)) {
    message.error('服务异常，请稍后刷新！');
    history.push('/error');
  } else if (responseStatus === 401) {
    if (history.location.pathname !== '/login') {
      localStorage.removeItem(config.authKey);
      history.push('/login');
    }
  } else {
    const res = await response.clone().json();
    if (res.code !== 200) {
      const msg = res.message || res.data;
      msg && message.error(msg);
    }
    return res;
  }
  return response;
});

export const request = _request;
