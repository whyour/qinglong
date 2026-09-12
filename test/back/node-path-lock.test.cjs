const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const helper = path.resolve('shell/node_path_cache.sh');
const hasFlock = spawnSync('/bin/bash', ['-c', 'type -P flock']).status === 0;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-path-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/bash\nprintf "call\\n" >> "$CALLS"\n[[ -n "${UMASK_FILE:-}" ]] && umask > "$UMASK_FILE"\nsleep "${LOOKUP_DELAY:-0.2}"\n[[ "${FAIL:-0}" == 1 ]] && exit 17\nprintf "%s\\n" "${npm_config_global_dir:-/test/global/node_modules}"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: root,
    PATH: bin + ':' + process.env.PATH,
    dir_tmp: path.join(root, 'cache'),
    CALLS: path.join(root, 'calls'),
    HELPER: helper,
  };
  const command = '. "$HELPER"; ql_get_node_global_path';
  const run = (extra = {}, code = command) =>
    spawnSync('/bin/bash', ['-euc', code], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  const asyncRun = (extra = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-euc', command], {
        cwd: root,
        env: { ...env, ...extra },
      });
      let out = '',
        err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (status) =>
        resolve({ status, stdout: out, stderr: err }),
      );
    });
  const count = () =>
    fs.existsSync(env.CALLS)
      ? fs.readFileSync(env.CALLS, 'utf8').trim().split('\n').length
      : 0;
  const cache = path.join(env.dir_tmp, `pnpm-root-${process.getuid()}.cache`);
  return {
    root,
    bin,
    env,
    command,
    run,
    asyncRun,
    count,
    cache,
    lock: cache + '.lock',
  };
}
function check(r, output = '/test/global/node_modules') {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), output);
}
test(
  'simultaneous cold and expired lookups share one successful refresh',
  { skip: !hasFlock },
  async (t) => {
    const f = fixture(t);
    for (let batch = 0; batch < 2; batch++) {
      if (batch) {
        const lines = fs.readFileSync(f.cache, 'utf8').split('\n');
        lines[1] = '0';
        fs.writeFileSync(f.cache, lines.join('\n'));
      }
      const rows = await Promise.all(
        Array.from({ length: 8 }, () => f.asyncRun({ LOOKUP_DELAY: '0.5' })),
      );
      rows.forEach((r) => check(r));
      assert.equal(f.count(), batch + 1);
    }
    assert.equal(fs.statSync(f.lock).mode & 0o777, 0o600);
    check(f.run());
    assert.equal(f.count(), 2);
  },
);
test(
  'waiters with different configuration do not reuse another key',
  { skip: !hasFlock },
  async (t) => {
    const f = fixture(t);
    const rows = await Promise.all(
      ['/first', '/second'].map((v) =>
        f.asyncRun({ npm_config_global_dir: v }),
      ),
    );
    rows.forEach((r, i) => check(r, ['/first', '/second'][i]));
    assert.equal(f.count(), 2);
  },
);
test(
  'lock timeout falls back while a holder is still alive',
  { skip: !hasFlock },
  async (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.env.dir_tmp);
    const holder = spawn(
      '/bin/bash',
      ['-c', 'exec 9>> "$LOCK"; flock 9; echo ready; sleep 30'],
      { env: { ...f.env, LOCK: f.lock }, detached: true },
    );
    t.after(() => {
      try {
        process.kill(-holder.pid, 'SIGKILL');
      } catch {}
    });
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });
    const start = Date.now();
    check(f.run());
    assert.ok(Date.now() - start >= 1800);
    assert.equal(holder.exitCode, null);
    assert.equal(f.count(), 1);
  },
);
test('absent or unsupported flock and unsafe lock paths preserve discovery', (t) => {
  const f = fixture(t);
  check(
    f.run(
      {},
      'type(){ if [[ "$*" == "-P flock" ]]; then return 1; fi; builtin type "$@"; }; ' +
        f.command,
    ),
  );
  fs.rmSync(f.cache);
  fs.writeFileSync(path.join(f.bin, 'flock'), '#!/bin/bash\nexit 64\n', {
    mode: 0o755,
  });
  check(f.run());
  fs.rmSync(f.cache);
  fs.rmSync(f.lock, { force: true });
  const victim = path.join(f.root, 'victim');
  fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(victim, f.lock);
  check(f.run());
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(f.count(), 3);
});
test('failed refresh releases lock and does not publish a success', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ FAIL: '1' }).status, 17);
  assert.equal(fs.existsSync(f.cache), false);
  check(f.run());
  assert.equal(f.count(), 2);
});
test('refresh leaves the caller file descriptor and umask unchanged', (t) => {
  const f = fixture(t);
  const sentinel = path.join(f.root, 'fd');
  const mask = path.join(f.root, 'mask');
  const r = f.run(
    { SENTINEL: sentinel, UMASK_FILE: mask },
    'umask 022; exec 9> "$SENTINEL"; ' +
      f.command +
      ' >/dev/null; printf preserved >&9; umask',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '0022');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
  assert.equal(fs.readFileSync(mask, 'utf8').trim(), '0022');
});
