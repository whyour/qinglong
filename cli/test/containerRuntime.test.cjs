const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { createContext } = require('../dist/local/context');
const { runContainer } = require('../dist/local/containerRuntime');

async function fixture(t, mode = 'node') {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-container-runtime-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['data', 'sample', 'etc', 'bin'])
    await fs.mkdir(path.join(root, name));
  for (const name of [
    'config.sample.sh',
    'task.sample.sh',
    'extra.sample.sh',
    'notify.py',
    'notify.js',
    'ql_sample.py',
    'ql_sample.js',
  ])
    await fs.writeFile(path.join(root, 'sample', name), '\n');
  const context = createContext(
    { root },
    {
      ...process.env,
      HOME: root,
      PATH: `${root}/bin:${process.env.PATH}`,
      QL_SCHEDULER: mode,
    },
  );
  const calls = [];
  const services = {
    start: async (runtime) => {
      calls.push({ action: 'start', env: runtime.env });
      return { manager: 'node' };
    },
    stop: async () => {
      calls.push({ action: 'stop' });
    },
    hook: async () => {
      throw new Error('unexpected hook');
    },
  };
  const controller = new AbortController();
  return {
    root,
    context,
    calls,
    controller,
    options: { services, systemDirectory: path.join(root, 'etc') },
  };
}

async function waitFile(filename) {
  for (let i = 0; i < 100; i++) {
    if (await fs.stat(filename).catch(() => false)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

test('container loads repaired configuration and exports ports/scheduler before service start', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, 'sample/config.sample.sh'),
    'QlPort=5799\nQlGrpcPort=5599\n',
  );
  const events = [];
  f.options.event = (event) => {
    events.push(event);
    if (event.event === 'started') f.controller.abort('SIGTERM');
  };
  assert.equal(
    await runContainer(f.context, f.controller.signal, f.options),
    143,
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ['start', 'stop'],
  );
  assert.equal(f.calls[0].env.BACK_PORT, '5799');
  assert.equal(f.calls[0].env.GRPC_PORT, '5599');
  assert.equal(f.calls[0].env.QL_SCHEDULER, 'node');
  assert.equal(f.context.env.BACK_PORT, process.env.BACK_PORT);
  assert.deepEqual(events, [
    { event: 'started', scheduler: 'node', manager: 'node' },
  ]);
});

test('system scheduler is auto-selected, receives termination and exits before service cleanup', async (t) => {
  const f = await fixture(t, '');
  const started = path.join(f.root, 'scheduler-started');
  const stopped = path.join(f.root, 'scheduler-stopped');
  f.context.env.QL_TEST_STARTED = started;
  f.context.env.QL_TEST_STOPPED = stopped;
  await fs.writeFile(
    path.join(f.root, 'bin/crond'),
    `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(process.env.QL_TEST_STARTED, JSON.stringify(process.argv.slice(2))); process.on('SIGTERM',()=>{fs.writeFileSync(process.env.QL_TEST_STOPPED, 'stopped');process.exit(0)}); setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  f.options.services.stop = async () => {
    assert.equal(await fs.readFile(stopped, 'utf8'), 'stopped');
    f.calls.push({ action: 'stop' });
  };
  const running = runContainer(f.context, f.controller.signal, f.options);
  t.after(() => f.controller.abort('SIGTERM'));
  await waitFile(started);
  f.controller.abort('SIGTERM');
  assert.equal(await running, 143);
  assert.equal(await fs.readFile(started, 'utf8'), '["-f"]');
  assert.equal(f.calls[0].env.QL_SCHEDULER, 'system');
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ['start', 'stop'],
  );
});

test('unexpected scheduler exit is a failure and stops the panel', async (t) => {
  const f = await fixture(t, 'system');
  await fs.writeFile(path.join(f.root, 'bin/crond'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  await assert.rejects(
    runContainer(f.context, f.controller.signal, f.options),
    /scheduler exited unexpectedly \(0\)|调度器意外退出（0）/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ['start', 'stop'],
  );
});

test('partial startup failure cleans services and invalid scheduler fails before startup', async (t) => {
  const f = await fixture(t);
  f.options.services.start = async () => {
    f.calls.push({ action: 'start' });
    throw new Error('partial startup');
  };
  await assert.rejects(
    runContainer(f.context, f.controller.signal, f.options),
    /partial startup/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ['start', 'stop'],
  );
  f.calls.length = 0;
  f.context.env.QL_SCHEDULER = 'invalid';
  await assert.rejects(
    runContainer(f.context, f.controller.signal, f.options),
    /must be node or system|必须为 node 或 system/,
  );
  assert.deepEqual(f.calls, []);
});

test('cancellation during service startup still cleans the partially started panel', async (t) => {
  const f = await fixture(t);
  f.options.services.start = async () => {
    f.calls.push({ action: 'start' });
    f.controller.abort('SIGINT');
    return { manager: 'node' };
  };
  assert.equal(
    await runContainer(f.context, f.controller.signal, f.options),
    130,
  );
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ['start', 'stop'],
  );
});

test(
  'actual extra startup hook finishes subprocess escalation before its supervisor is killed',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const { launchStartupHook } = require('../dist/local/bootstrap');
    const pidFile = path.join(f.root, 'extra-pid');
    f.context.env.QL_TEST_EXTRA_PID = pidFile;
    await fs.writeFile(
      path.join(f.root, 'sample/config.sample.sh'),
      'EnableExtraShell=true\n',
    );
    await fs.writeFile(
      path.join(f.root, 'sample/extra.sample.sh'),
      'trap "" TERM\nprintf "%s" "$$" > "$QL_TEST_EXTRA_PID"\nwhile :; do sleep 1; done\n',
    );
    let hookPid;
    f.options.services.hook = async (runtime, action) => {
      hookPid = await launchStartupHook(runtime, action);
      return hookPid;
    };
    const live = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const running = runContainer(f.context, f.controller.signal, f.options);
    let extraPid;
    t.after(async () => {
      f.controller.abort('SIGTERM');
      for (const pid of [extraPid, hookPid])
        if (pid) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      await running.catch(() => {});
    });
    await waitFile(pidFile);
    extraPid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.ok(extraPid > 1 && hookPid > 1);
    assert.equal(live(extraPid), true);
    f.controller.abort('SIGTERM');
    assert.equal(await running, 143);
    for (let i = 0; i < 20 && (live(extraPid) || live(hookPid)); i++)
      await delay(50);
    assert.equal(
      live(extraPid),
      false,
      'extra subprocess must not outlive container cleanup',
    );
    assert.equal(live(hookPid), false, 'startup supervisor must exit');
    const log = await fs.readFile(
      path.join(f.root, 'data/log/extra.log'),
      'utf8',
    );
    const result = log
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(result.code, 143);
    assert.equal(
      result.message,
      f.context.env.QL_LANG === 'en'
        ? 'CLI operation cancelled.'
        : 'CLI 操作已取消。',
    );
  },
);

for (const language of ['zh', 'en', 'unsupported']) {
  test(`container scheduler errors are localized and preserve cleanup: ${language}`, async (t) => {
    const f = await fixture(t, 'invalid');
    f.context.env.QL_LANG = language;
    await assert.rejects(
      runContainer(f.context, f.controller.signal, f.options),
      language === 'en' ? /must be node or system/ : /必须为 node 或 system/,
    );
    assert.deepEqual(f.calls, []);
    f.context.env.QL_SCHEDULER = 'system';
    await fs.writeFile(
      path.join(f.root, 'bin/crond'),
      `#!${process.execPath}\nprocess.exitCode=7;`,
      { mode: 0o755 },
    );
    await assert.rejects(
      runContainer(f.context, f.controller.signal, f.options),
      language === 'en' ? /unexpectedly \(7\)/ : /意外退出（7）/,
    );
    assert.deepEqual(
      f.calls.map((call) => call.action),
      ['start', 'stop'],
    );
  });
}
