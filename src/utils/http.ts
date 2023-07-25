import { message } from 'antd';
import config from './config';
import { history } from '@umijs/max';
import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
} from 'axios';

interface IResponseData {
  code?: number;
  data?: any;
  message?: string;
  error?: any;
}

type Override<
  T,
  K extends Partial<{ [P in keyof T]: any }> | string,
> = K extends string
  ? Omit<T, K> & { [P in keyof T]: T[P] | unknown }
  : Omit<T, keyof K> & K;

message.config({
  duration: 2,
});

const time = Date.now();
const errorHandler = function (
  error: AxiosError,
) {
  if (error.response) {
    const msg = error.response.data
      ? error.response.data.message || error.message || error.response.data
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
      message.error({
        content: msg,
        style: { maxWidth: 500, margin: '0 auto' },
      });
    }
  } else {
    console.log(error.message);
  }

  return Promise.reject(error);
};

let _request = axios.create({
  timeout: 60000,
  params: { t: time },
});

const apiWhiteList = [
  '/api/user/login',
  '/open/auth/token',
  '/api/user/two-factor/login',
  '/api/system',
  '/api/user/init',
  '/api/user/notification/init',
];

_request.interceptors.request.use((_config) => {
  const token = localStorage.getItem(config.authKey);
  if (token && !apiWhiteList.includes(_config.url!)) {
    _config.headers.Authorization = `Bearer ${token}`;
    return _config;
  }
  return _config;
});

_request.interceptors.response.use(async (response) => {
  const responseStatus = response.status;
  if ([502, 504].includes(responseStatus)) {
    history.push('/error');
  } else if (responseStatus === 401) {
    if (history.location.pathname !== '/login') {
      localStorage.removeItem(config.authKey);
      history.push('/login');
    }
  } else {
    try {
      const res = response.data;
      if (res.code !== 200) {
        const msg = res.message || res.data;
        msg &&
          message.error({
            content: msg,
            style: { maxWidth: 500, margin: '0 auto' },
          });
      }
      return res;
    } catch (error) { }
    return response;
  }
  return response;
}, errorHandler);

export const request = _request as Override<AxiosInstance, {
  get<T = IResponseData, D = any>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
  delete<T = IResponseData, D = any>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
  post<T = IResponseData, D = any>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
  put<T = IResponseData, D = any>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
}>;
