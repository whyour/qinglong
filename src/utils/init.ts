import * as Sentry from '@sentry/react';
import { Integrations } from '@sentry/tracing';
import { loader } from '@monaco-editor/react';
import { version } from '../version';

export function init() {
  // sentry监控 init
  Sentry.init({
    dsn: 'https://3406424fb1dc4813a62d39e844a9d0ac@o1098464.ingest.sentry.io/6122818',
    integrations: [new Integrations.BrowserTracing()],
    release: version,
    tracesSampleRate: 1.0,
  });

  // monaco 编辑器配置cdn和locale
  loader.config({
    paths: {
      vs: 'https://cdn.staticfile.org/monaco-editor/0.32.1/min/vs',
    },
    'vs/nls': {
      availableLanguages: {
        '*': 'zh-cn',
      },
    },
  });
}
