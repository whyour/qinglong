#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const build = spawnSync(
  'pnpm',
  ['--filter', '@qinglong/local-owner-cli', 'build'],
  { cwd: root, encoding: 'utf8', stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const test = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-name-pattern',
    'real stopped Docker target',
    path.join(
      root,
      'packages/ql3-local-owner-cli/test/reconciliationCapturePrepare.test.cjs',
    ),
  ],
  {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, QL3_RECONCILIATION_DOCKER_GATE: '1' },
  },
);
process.exit(test.status ?? 1);
