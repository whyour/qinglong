const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  runProcess,
  withLifecycleHooks,
  withUpgradeLock,
} = require('../../shell/upgrade.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertStopped(pid) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    // Linux PID 1 can retain a dead orphan until it is reaped. It can also
    // disappear between kill(0) and ps; neither state is a running installer.
    if (
      (state.status === 1 && !state.stdout.trim()) ||
      /^Z/.test(state.stdout.trim())
    )
      return;
    assert.equal(state.status, 0, state.stderr);
    await delay(20);
  }
  assert.fail(`test process ${pid} is still running`);
}

async function fixture(t, directory) {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-upgrade-lifecycle-'),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = directory ? path.join(base, directory) : base;
  const tmp = path.join(root, '.tmp');
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(path.join(root, 'shell/lang'), { recursive: true });
  await fs.writeFile(path.join(root, 'shell/lang/zh.sh'), '');
  await fs.writeFile(
    path.join(root, 'shell/env.sh'),
    await fs.readFile('shell/env.sh'),
  );
  return { root, tmp, env: { ...process.env, QL_DIR: root } };
}

test('installed stop/start hooks do not match their own pkill and survive shell replacement', async (t) => {
  const f = await fixture(t);
  // Only the test's random path can match; never signal a running panel.
  const marker = `review/${randomUUID()}/app.js`;
  const helpers = (await fs.readFile('shell/share.sh', 'utf8')).replaceAll(
    'static/build/app.js',
    marker,
  );
  await fs.writeFile(
    path.join(f.root, 'shell/share.sh'),
    `${helpers}
pm2() { printf '%s\\n' "$*" >> "$QL_DIR/pm2-calls"; }
${process.platform === 'darwin' ? 'pkill() { command pkill -a "$@"; }' : ''}
`,
  );
  await withUpgradeLock(f.tmp, () =>
    withLifecycleHooks(f.root, f.tmp, f.env, async (hook) => {
      await fs.writeFile(path.join(f.root, 'shell/share.sh'), 'exit 99');
      await hook('stop');
      await hook('start');
      assert.match(
        await fs.readFile(path.join(f.root, 'pm2-calls'), 'utf8'),
        /startOrGracefulReload/,
      );
    }),
  );
  assert.deepEqual(await fs.readdir(f.tmp), []);
});

test(
  'the installed Node fallback starts successfully and its stop hook kills only the test backend',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const marker = `review/${randomUUID()}/app.js`;
    let pid;
    t.after(() => {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
    const helpers = (await fs.readFile('shell/share.sh', 'utf8')).replaceAll(
      'static/build/app.js',
      marker,
    );
    await fs.writeFile(
      path.join(f.root, 'shell/share.sh'),
      `${helpers}
pm2() { return 1; }
${process.platform === 'darwin' ? 'pkill() { command pkill -a "$@"; }' : ''}
`,
    );
    await fs.mkdir(path.dirname(path.join(f.root, marker)), {
      recursive: true,
    });
    await fs.mkdir(path.join(f.root, 'data/log'), { recursive: true });
    await fs.writeFile(
      path.join(f.root, marker),
      `require('node:fs').writeFileSync(process.env.QL_DIR + '/backend-pid', String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await withUpgradeLock(f.tmp, () =>
      withLifecycleHooks(f.root, f.tmp, f.env, async (hook) => {
        await hook('start');
        for (let attempt = 0; attempt < 150; attempt++) {
          try {
            pid = Number(
              await fs.readFile(path.join(f.root, 'backend-pid'), 'utf8'),
            );
            break;
          } catch {
            await delay(20);
          }
        }
        assert.ok(pid, 'fallback backend started');
        process.kill(pid, 0);
        await hook('stop');
        await assertStopped(pid);
      }),
    );
  },
);

for (const { redirect, ignoreShell } of [
  { redirect: false, ignoreShell: false },
  { redirect: true, ignoreShell: false },
  { redirect: false, ignoreShell: true },
])
  test(
    `cancelled installation stops descendants before releasing its lock (${JSON.stringify(
      { redirect, ignoreShell },
    )})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const controller = new AbortController();
      let pid;
      t.after(() => {
        controller.abort();
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      });
      const worker = path.join(f.root, 'installer.cjs');
      await fs.writeFile(
        worker,
        `
const fs = require('node:fs'), path = require('node:path');
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(process.env.QL_DIR, 'installer-pid'), String(process.pid));
setInterval(() => fs.appendFileSync(path.join(process.env.QL_DIR, 'heartbeat'), 'x'), 20);
`,
      );
      await fs.writeFile(
        path.join(f.root, 'shell/share.sh'),
        `import_config() { :; }
npm_install_2() {
  ${ignoreShell ? "trap '' TERM" : ':'}
  "$TEST_NODE" "$1"${redirect ? ' >/dev/null 2>&1' : ''}
  exit_status=$?
}
`,
      );
      const operation = withUpgradeLock(f.tmp, () =>
        withLifecycleHooks(
          f.root,
          f.tmp,
          { ...f.env, TEST_NODE: process.execPath },
          (hook) => hook('install', [worker], controller.signal),
        ),
      );
      // Attach rejection handling before aborting the in-flight operation.
      const rejection = assert.rejects(operation, /cancelled installation/);
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          pid = Number(
            await fs.readFile(path.join(f.root, 'installer-pid'), 'utf8'),
          );
          await fs.access(path.join(f.root, 'heartbeat'));
          break;
        } catch {
          await delay(20);
        }
      }
      assert.ok(pid, 'installer started');
      await fs.access(path.join(f.tmp, 'upgrade.lock'));
      controller.abort(new Error('cancelled installation'));
      await rejection;
      assert.deepEqual(await fs.readdir(f.tmp), []);
      const before = await fs.readFile(path.join(f.root, 'heartbeat'), 'utf8');
      await delay(100);
      assert.equal(
        await fs.readFile(path.join(f.root, 'heartbeat'), 'utf8'),
        before,
      );
      await assertStopped(pid);
    },
  );

test('an already cancelled command does not spawn and a spawn failure releases the upgrade lock', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled before spawn'));
  const script = path.join(f.root, 'never-run.sh');
  await fs.writeFile(script, 'touch "$QL_DIR/spawned"');
  await assert.rejects(
    runProcess(f.env, 'bash', ['--', script], false, controller.signal),
    /cancelled before spawn/,
  );
  await assert.rejects(fs.access(path.join(f.root, 'spawned')), {
    code: 'ENOENT',
  });
  await assert.rejects(
    withUpgradeLock(f.tmp, () =>
      runProcess(f.env, path.join(f.root, 'missing-program'), []),
    ),
    { code: 'ENOENT' },
  );
  assert.deepEqual(await fs.readdir(f.tmp), []);
});

test('fixed lifecycle dispatch treats spaces, quotes and command substitutions in paths as data', async (t) => {
  const special =
    'panel spaces \u0027"; $(touch "$TEST_MARKER"); `touch "$TEST_MARKER"`';
  const f = await fixture(t, special);
  const marker = path.join(f.root, 'injected');
  const source = path.join(f.root, 'source ' + special);
  await fs.writeFile(
    path.join(f.root, 'shell/share.sh'),
    `
import_config() { :; }
delete_pm2() { printf stopped > "$QL_DIR/stopped"; }
reload_pm2() { printf started > "$QL_DIR/started"; }
npm_install_2() { printf '%s' "$1" > "$QL_DIR/installed"; exit_status=0; }
`,
  );
  await withUpgradeLock(f.tmp, () =>
    withLifecycleHooks(
      f.root,
      f.tmp,
      { ...f.env, TEST_MARKER: marker },
      async (hook) => {
        await hook('stop');
        await hook('start');
        await hook('install', [source]);
        assert.equal(
          await fs.readFile(path.join(f.root, 'stopped'), 'utf8'),
          'stopped',
        );
        assert.equal(
          await fs.readFile(path.join(f.root, 'started'), 'utf8'),
          'started',
        );
        assert.equal(
          await fs.readFile(path.join(f.root, 'installed'), 'utf8'),
          source,
        );
        await assert.rejects(fs.access(marker), { code: 'ENOENT' });
        await assert.rejects(hook('touch "$TEST_MARKER"'), /exit 2/);
        await assert.rejects(fs.access(marker), { code: 'ENOENT' });
      },
    ),
  );
  assert.deepEqual(await fs.readdir(f.tmp), []);
});
