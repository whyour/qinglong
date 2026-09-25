const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('legacy Shell and TS preserve task stdin in each execution mode', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-stdin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['shell/preload', 'shell/lang', 'data/config', 'data/scripts', 'data/log', 'static/build', 'bin'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ['task.sh', 'otask.sh', 'share.sh', 'api.sh', 'env.sh'])
    fs.copyFileSync(path.resolve(__dirname, '../../../shell', name), path.join(root, 'shell', name));
  for (const name of ['zh.sh', 'en.sh'])
    fs.copyFileSync(path.resolve(__dirname, '../../../shell/lang', name), path.join(root, 'shell/lang', name));
  fs.symlinkSync(process.execPath, path.join(root, 'bin/node'));
  fs.writeFileSync(path.join(root, 'bin/pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'static/build/token.js'), 'process.stdout.write("fixture")');
  fs.writeFileSync(path.join(root, 'data/config/config.sh'), 'no_tee=true\n');
  fs.writeFileSync(path.join(root, 'data/config/crontab.list'), '');
  fs.writeFileSync(path.join(root, 'shell/preload/env.sh'), 'export ACCOUNTS=one\n');
  fs.writeFileSync(path.join(root, 'data/scripts/read.sh'),
    'IFS= read -r value\nprintf "value=%s\\n" "$value" > "$TRACE"\n');
  const env = {
    PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`,
    QL_DIR: root,
    QL_DATA_DIR: path.join(root, 'data'),
    no_delay: 'true',
  };
  for (const mode of ['normal', 'now', 'desi', 'conc']) {
    const args = ['read.sh', ...(mode === 'normal' ? [] : [mode]),
      ...(['desi', 'conc'].includes(mode) ? ['ACCOUNTS', '1'] : [])];
    for (const [label, command, prefix] of [
      ['shell', '/bin/bash', [path.join(root, 'shell/task.sh')]],
      ['ts', process.execPath, [path.resolve(__dirname, '../../dist/runner.js'), '--root', root]],
    ]) {
      const trace = path.join(root, `${mode}-${label}`);
      const result = spawnSync(command, [...prefix, ...args], {
        env: { ...env, TRACE: trace }, input: 'hello\n', encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, 0, `${mode}/${label}: ${result.stderr}`);
      assert.equal(fs.readFileSync(trace, 'utf8'), 'value=hello\n', `${mode}/${label}`);
    }
  }
});
