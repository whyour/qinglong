const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('legacy Shell and TS resolve executable paths after selecting the working directory', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ql-executable-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['shell/preload', 'shell/lang', 'data/config', 'data/scripts/bin', 'data/scripts/custom', 'data/log', 'static/build', 'bin'])
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
  const script = '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$TRACE"\n';
  for (const file of ['data/scripts/bin/tool', 'data/scripts/bin/tool.exe', 'data/scripts/custom/tool', 'bin/path-tool'])
    fs.writeFileSync(path.join(root, file), script, { mode: 0o755 });
  const cases = [
    ['bin/tool', '', 'bin'],
    ['./bin/tool', '', 'bin'],
    ['bin/tool.exe', '', 'bin'],
    [path.join(root, 'data/scripts/bin/tool'), '', 'bin'],
    ['bin/tool', 'custom', 'custom'],
    ['path-tool', '', ''],
  ];
  for (const [program, workDir, directory] of cases) {
    for (const [label, command, prefix] of [
      ['shell', '/bin/bash', [path.join(root, 'shell/task.sh')]],
      ['ts', process.execPath, [path.resolve(__dirname, '../../dist/runner.js'), '--root', root]],
    ]) {
      const trace = path.join(root, `${label}.trace`);
      fs.rmSync(trace, { force: true });
      const result = spawnSync(command, [...prefix, program, 'first', 'two words'], {
        env: { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, QL_DIR: root, work_dir: workDir, TRACE: trace },
        encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, 0, `${label}/${program}: ${result.stderr}`);
      assert.equal(fs.readFileSync(trace, 'utf8'),
        `${path.join(root, 'data/scripts', directory)}\nfirst\ntwo words\n`, `${label}/${program}`);
    }
  }
});
