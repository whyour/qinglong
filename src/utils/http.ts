import { extend } from 'umi-request';
import { message } from 'antd';
import config from './config';

message.config({
  duration: 1.5,
});

const time = Date.now();
const errorHandler = function (error: any) {
  if (error.response) {
    const message = error.data
      ? error.data.message || error.data
      : error.response.statusText;
    if (error.response.status !== 401 && error.response.status !== 502) {
      message.error(message);
    } else {
      console.log(error.response);
    }
  } else {
    console.log(error.message);
  }

  throw error; // 如果throw. 错误将继续抛出.
};

const _request = extend({ timeout: 60000, params: { t: time }, errorHandler });

_request.interceptors.request.use((url, options) => {
  const token = localStorage.getItem(config.authKey);
  if (token) {
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
