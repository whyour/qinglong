const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const helper = path.resolve('shell/node_path_cache.sh');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-node-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const calls = path.join(root, 'calls');
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/bash\necho call >> "$CALLS"\n[[ "${FAIL:-0}" == 1 ]] && exit 1\nprintf "%s\\n" "${ANSWER:-/test/global/node_modules}"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    dir_tmp: path.join(root, 'cache'),
    CALLS: calls,
    HELPER: helper,
  };
  const command = '. "$HELPER"; ql_get_node_global_path';
  const run = (extra = {}, code = command) =>
    spawnSync('/bin/bash', ['-uc', code], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  const count = () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, 'utf8').trim().split('\n').length
      : 0;
  return { root, bin, env, command, run, count };
}
test('warm cache avoids pnpm, preserves spaces, and never evaluates cached text', (t) => {
  const f = fixture(t);
  const answer = '/test/path with spaces/$(touch injected)';
  assert.equal(f.run({ ANSWER: answer }).stdout.trim(), answer);
  assert.equal(f.run({ ANSWER: '/different' }).stdout.trim(), answer);
  assert.equal(f.count(), 1);
  assert.equal(fs.existsSync(path.join(f.root, 'injected')), false);
});
test('config, environment, cwd, and executable changes invalidate discovery', (t) => {
  const f = fixture(t);
  f.run();
  fs.writeFileSync(path.join(f.root, '.npmrc'), 'global-dir=/other\n');
  f.run();
  assert.equal(f.count(), 2);
  f.run({ npm_config_global_dir: '/third' });
  assert.equal(f.count(), 3);
  f.run({ PNPM_HOME: '/fourth' });
  assert.equal(f.count(), 4);
  fs.mkdirSync(path.join(f.root, 'child'));
  f.run({}, 'cd child; ' + f.command);
  assert.equal(f.count(), 5);
  f.run();
  const before = f.count();
  fs.appendFileSync(path.join(f.bin, 'pnpm'), '# upgrade\n');
  f.run();
  assert.equal(f.count(), before + 1);
});
test('expired or malformed records refresh and failed lookups are not cached', (t) => {
  const f = fixture(t);
  f.run();
  const file = path.join(
    f.env.dir_tmp,
    fs.readdirSync(f.env.dir_tmp).find((name) => name.endsWith('.cache')),
  );
  let lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = '0';
  fs.writeFileSync(file, lines.join('\n'));
  f.run();
  assert.equal(f.count(), 2);
  fs.writeFileSync(file, lines[0] + '\n08\n/incorrect\n');
  assert.equal(f.run().status, 0);
  assert.equal(f.count(), 3);
  fs.writeFileSync(file, lines[0]);
  assert.equal(f.run().status, 0);
  assert.equal(f.count(), 4);
  fs.rmSync(file);
  assert.equal(f.run({ FAIL: '1' }).status, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(f.run().status, 0);
  assert.equal(f.count(), 6);
});
test('disabled or unavailable cache falls back without changing discovery output', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++)
    assert.equal(
      f.run({ QL_NODE_PATH_CACHE: '0' }).stdout.trim(),
      '/test/global/node_modules',
    );
  assert.equal(f.count(), 2);
  assert.equal(fs.existsSync(f.env.dir_tmp), false);
  const blocked = path.join(f.root, 'file');
  fs.writeFileSync(blocked, '');
  assert.equal(
    f.run({ dir_tmp: blocked }).stdout.trim(),
    '/test/global/node_modules',
  );
  assert.equal(f.count(), 3);
});
test('concurrent refreshes publish complete records and do not overwrite symlink targets', async (t) => {
  const f = fixture(t);
  await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve, reject) => {
          const p = spawn('/bin/bash', ['-uc', f.command], {
            cwd: f.root,
            env: f.env,
          });
          let out = '';
          p.stdout.on('data', (c) => (out += c));
          p.once('error', reject);
          p.once('close', (code) => {
            try {
              assert.equal(code, 0);
              assert.equal(out.trim(), '/test/global/node_modules');
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        }),
    ),
  );
  const before = f.count();
  f.run();
  assert.equal(f.count(), before);
  const files = fs
    .readdirSync(f.env.dir_tmp)
    .filter((file) => file.endsWith('.cache'));
  assert.equal(files.length, 1);
  const file = path.join(f.env.dir_tmp, files[0]);
  fs.rmSync(file);
  const victim = path.join(f.root, 'victim');
  fs.writeFileSync(victim, 'unchanged');
  fs.symlinkSync(victim, file);
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
});

test('task entry tolerates discovery failure with errexit enabled', (t) => {
  const f = fixture(t);
  const source = fs.readFileSync(path.resolve('shell/otask.sh'), 'utf8');
  const start = source.indexOf('append_node_dependency_path() {');
  const end = source.indexOf('\nenter_script_workdir()', start);
  const script =
    source.slice(start, end) +
    '\nappend_node_dependency_path; printf "continued:%s" "$NODE_PATH"';
  for (const dir of [path.dirname(helper), f.root]) {
    const r = f.run(
      {
        FAIL: '1',
        dir_shell: dir,
        dir_dep: '/legacy/deps',
        NODE_PATH: '/existing',
      },
      'set -e; ' + script,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'continued:/existing:/legacy/deps');
  }
});
