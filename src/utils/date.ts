import Intl from 'react-intl-universal';

export function diffTime(num: number) {
  const diff = num * 1000;

  const days = Math.floor(diff / (24 * 3600 * 1000));

  const leave1 = diff % (24 * 3600 * 1000);
  const hours = Math.floor(leave1 / (3600 * 1000));

  const leave2 = leave1 % (3600 * 1000);
  const minutes = Math.floor(leave2 / (60 * 1000));

  const leave3 = leave2 % (60 * 1000);
  const seconds = Math.round(leave3 / 1000);

  let returnStr = `${seconds} ${Intl.get('秒')}`;
  if (minutes > 0) {
    returnStr = `${minutes} ${Intl.get('分')} ` + returnStr;
  }
  if (hours > 0) {
    returnStr = `${hours} ${Intl.get('时')} ` + returnStr;
  }
  if (days > 0) {
    returnStr = `${days} ${Intl.get('天')} ` + returnStr;
  }
  return returnStr;
}
