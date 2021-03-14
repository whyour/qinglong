import { extend } from 'umi-request';
import { history } from 'umi';

const time = Date.now();
const errorHandler = function (error: any) {
  if (error.response) {
    console.log(error.response)
  } else {
    console.log(error.message);
  }

  throw error; // 如果throw. 错误将继续抛出.
  // return {some: 'data'};
};

const _request = extend({ timeout: 5000, params: { t: time }, errorHandler });

_request.interceptors.response.use(async response => {
  const res = await response.clone().text()
  if (res === '请先登录!') {
    setTimeout(() => {
      localStorage.removeItem('whyour');
      history.push('/login');
    });
  }
  return response;
})

export const request = _request;
