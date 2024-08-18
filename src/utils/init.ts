import * as Sentry from '@sentry/react';
import { loader } from '@monaco-editor/react';
import config from './config';
import { useEffect } from 'react';
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';

export function init(version: string) {
  // sentry监控 init
  Sentry.init({
    dsn: 'https://49b9ad1a6201bfe027db296ab7c6d672@o1098464.ingest.sentry.io/6122818',
    integrations: [
      Sentry.reactRouterV6BrowserTracingIntegration({
        useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
      Sentry.replayIntegration(),
    ],
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data && breadcrumb.data.url) {
        const url = breadcrumb.data.url.replace(/token=.*/, '');
        breadcrumb.data.url = url;
      }
      return breadcrumb;
    },
    tracesSampleRate: 0.1,
    tracePropagationTargets: [/^(?!\/api\/(ws|static)).*$/],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 0.1,
    release: version,
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
