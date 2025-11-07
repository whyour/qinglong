const baseUrl = window.__ENV__QlBaseUrl || '/';
import { setLocale } from '@umijs/max';
import intl from 'react-intl-universal';

export function rootContainer(container: any) {
  const locales = {
    'en': require('./locales/en-US.json'),
    'zh': require('./locales/zh-CN.json'),
  };
  let currentLocale: string;
  try {
    currentLocale = intl.determineLocale({
      urlLocaleKey: 'lang',
      cookieLocaleKey: 'lang',
      localStorageLocaleKey: 'lang',
    }).slice(0, 2);
  } catch (e: unknown) {
    // Handle decodeURIComponent errors from malformed cookies
    console.warn('Failed to determine locale from cookies:', e);
    currentLocale = '';
  }

  if (!currentLocale || !Object.keys(locales).includes(currentLocale)) {
    currentLocale = 'zh';
  }

  intl.init({ currentLocale, locales });
  setLocale(currentLocale === 'zh' ? 'zh-CN' : 'en-US');
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
