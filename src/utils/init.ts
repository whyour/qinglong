import * as Sentry from '@sentry/react';
import { loader } from '@monaco-editor/react';
import config from './config';

export function init(version: string) {
  // sentry监控 init
  Sentry.init({
    dsn: 'https://49b9ad1a6201bfe027db296ab7c6d672@o1098464.ingest.sentry.io/6122818',
    integrations: [
      new Sentry.BrowserTracing({
        shouldCreateSpanForRequest(url) {
          return !url.includes('/api/ws') && !url.includes('/api/static');
        },
      }),
    ],
    release: version,
    tracesSampleRate: 0.1,
    beforeBreadcrumb(breadcrumb, hint?) {
      if (breadcrumb.data && breadcrumb.data.url) {
        const url = breadcrumb.data.url.replace(/token=.*/, '');
        breadcrumb.data.url = url;
      }
      return breadcrumb;
    },
  });

  // monaco 编辑器配置cdn和locale
  loader.config({
    paths: {
      vs: `${config.baseUrl}monaco-editor/min/vs`,
    },
    'vs/nls': {
      availableLanguages: {
        '*': 'zh-cn',
      },
    },
  });
}
