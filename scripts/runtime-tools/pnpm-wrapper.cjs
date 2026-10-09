#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const toolsHome = path.resolve(__dirname, '..');
const prefix = path.resolve(toolsHome, '../../..');
const args = process.argv.slice(2);
const end = args.indexOf('--');
const options = end < 0 ? args : args.slice(0, end);
const global = options.some(arg => ['-g', '--global', '--location=global'].includes(arg));
const cli = path.join(toolsHome, 'node_modules/pnpm/bin/pnpm.cjs');
const forwarded = global ? ['--config.dangerously-allow-all-builds=true', ...args] : args;
const result = spawnSync(process.execPath, [cli, ...forwarded], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: path.join(prefix, 'bin') + path.delimiter + (process.env.PATH || ''),
    npm_config_node_gyp: path.join(toolsHome, 'node_modules/node-gyp/bin/node-gyp.js'),
  },
});
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
