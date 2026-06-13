import { existsSync } from 'node:fs';
import { join } from 'node:path';

const builtinModules = [
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'process', 'querystring',
  'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util',
  'v8', 'zlib',
];

function isBareSpecifier(specifier) {
  return !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('file:') &&
    !specifier.startsWith('node:') &&
    !builtinModules.includes(specifier) &&
    !builtinModules.includes(specifier.split('/')[0]);
}

export function resolve(specifier, context, nextResolve) {
  if (!isBareSpecifier(specifier)) {
    return nextResolve(specifier, context);
  }

  // 解析优先级：全局 pnpm > 系统全局
  const bases = [
    process.env.QL_NODE_GLOBAL_PATH,
    '/usr/local/lib/node_modules',
  ].filter(Boolean);

  for (const base of bases) {
    if (existsSync(join(base, specifier))) {
      return nextResolve(specifier, {
        ...context,
        parentURL: new URL(`${join(base, specifier)}/`, 'file://').href,
      });
    }
  }

  return nextResolve(specifier, context);
}
