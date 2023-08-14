const baseUrl = window.__ENV__QlBaseUrl || '/';
import intl from 'react-intl-universal';

export function rootContainer(container: any) {
  const locales = {
    'en': require('./locales/en-US.json'),
    'zh': require('./locales/zh-CN.json'),
  };
  let currentLocale = intl.determineLocale({
    urlLocaleKey: 'lang',
    cookieLocaleKey: 'lang',
  }).slice(0, 2);

  if (!currentLocale || !Object.keys(locales).includes(currentLocale)) {
    currentLocale = 'zh';
  }

  intl.init({ currentLocale, locales });
  return container;
}

export function modifyClientRenderOpts(memo: any) {
  return {
    ...memo,
    publicPath: baseUrl,
    basename: baseUrl,
  };
}

export function modifyContextOpts(memo: any) {
  return {
    ...memo,
    basename: baseUrl,
  };
}
