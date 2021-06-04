import config from './config';

export function getToken() {
  const token = localStorage.getItem(config.authKey);
  return token;
}
