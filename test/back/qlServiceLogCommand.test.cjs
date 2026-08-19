'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-log-command-'));

after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

test('ql log scopes PM2 output to qinglong and forwards log options', () => {
  const shellDir = path.join(fixtureRoot, 'shell');
  const binDir = path.join(fixtureRoot, 'bin');
  fs.mkdirSync(shellDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.copyFileSync(
    path.join(root, 'shell/update.sh'),
    path.join(shellDir, 'update.sh'),
  );
  fs.writeFileSync(
    path.join(shellDir, 'share.sh'),
    'load_ql_envs() { :; }\nimport_config() { :; }\n',
  );
  fs.writeFileSync(path.join(shellDir, 'api.sh'), '');
  fs.writeFileSync(path.join(shellDir, 'env.sh'), '');
  writeExecutable(
    path.join(binDir, 'pm2'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
  );

  const result = spawnSync(
    '/bin/bash',
    [path.join(shellDir, 'update.sh'), 'log', '--lines', '25', '--nostream'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        QL_DIR: fixtureRoot,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'logs\nqinglong\n--lines\n25\n--nostream\n');
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'data/log/log')), false);
});
