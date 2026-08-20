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

function prepareFixture(name) {
  const testRoot = path.join(fixtureRoot, name);
  const shellDir = path.join(testRoot, 'shell');
  const binDir = path.join(testRoot, 'bin');
  fs.mkdirSync(shellDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.copyFileSync(
    path.join(root, 'shell/update.sh'),
    path.join(shellDir, 'update.sh'),
  );
  fs.writeFileSync(
    path.join(shellDir, 'share.sh'),
    [
      'dir_data="${QL_DATA_DIR:-$QL_DIR/data}"',
      'load_ql_envs() { :; }',
      'import_config() { :; }',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(shellDir, 'api.sh'), '');
  fs.writeFileSync(path.join(shellDir, 'env.sh'), '');
  writeExecutable(
    path.join(binDir, 'pm2'),
    '#!/usr/bin/env bash\necho "pm2 must not be called" >&2\nexit 99\n',
  );

  return { binDir, shellDir, testRoot };
}

test('ql log reads the requested system log history without PM2', () => {
  const { binDir, shellDir, testRoot } = prepareFixture('host');
  const systemLogDir = path.join(testRoot, 'data/syslog');
  fs.mkdirSync(systemLogDir, { recursive: true });
  fs.writeFileSync(
    path.join(systemLogDir, '2026-08-20.log'),
    'system-one\nsystem-two\nsystem-three\n',
  );

  const result = spawnSync(
    '/bin/bash',
    [path.join(shellDir, 'update.sh'), 'log', '--lines', '2', '--nostream'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        QL_CONTAINER: 'false',
        QL_DIR: testRoot,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'system-two\nsystem-three\n');
  assert.equal(fs.existsSync(path.join(testRoot, 'data/log/log')), false);
});

test('ql log follows the current Winston system log without PM2', () => {
  const { binDir, shellDir, testRoot } = prepareFixture('container');
  const systemLogDir = path.join(testRoot, 'data/syslog');
  const currentDate = spawnSync('date', ['+%F'], { encoding: 'utf8' }).stdout.trim();
  const currentLog = path.join(systemLogDir, `${currentDate}.log`);
  fs.mkdirSync(systemLogDir, { recursive: true });
  fs.writeFileSync(currentLog, 'system-one\n');
  writeExecutable(
    path.join(binDir, 'tail'),
    '#!/usr/bin/env bash\nprintf "tail"\nprintf " <%s>" "$@"\nprintf "\\n"\n',
  );

  const result = spawnSync(
    '/bin/bash',
    [path.join(shellDir, 'update.sh'), 'log', '--lines', '0'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        QL_CONTAINER: 'true',
        QL_DIR: testRoot,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `tail <-n> <0> <--retry> <-F> <${currentLog}>\n`);
  assert.equal(fs.existsSync(path.join(testRoot, 'data/log/log')), false);
});

test('ql log reports when no persisted system log exists', () => {
  const { binDir, shellDir, testRoot } = prepareFixture('container-nostream');

  const result = spawnSync(
    '/bin/bash',
    [path.join(shellDir, 'update.sh'), 'log', '--nostream'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        QL_CONTAINER: 'true',
        QL_DIR: testRoot,
      },
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no system log found/);
});
