import { loader } from '@monaco-editor/react';
import config from './config';

export function init(version: string) {
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
