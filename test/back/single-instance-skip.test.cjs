const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

function fixture(row, { claim = true, onSpawn = () => {} } = {}) {
  const spawned = [],
    cronWrites = [],
    instanceWrites = [],
    instanceReads = [];
  const { runCron } = load('back/shared/runCron.ts', {
    './i18n': { t: (s) => s },
    'cross-spawn': {
      spawn: (cmd) => {
        spawned.push(cmd);
        onSpawn(row);
        return { pid: process.pid };
      },
    },
    './pLimit': {
      runWithCronLimit: (_cron, execute) => execute(),
      removeQueuedCron() {},
    },
    '../loaders/logger': { info() {}, error() {} },
    '../data/cron': {
      CrontabModel: {
        findOne: async () => row,
        update: async (...args) => {
          cronWrites.push(args);
          if (!claim) return [0];
          Object.assign(row, args[0]);
          return [1];
        },
      },
      CrontabStatus: { running: 0, idle: 1, queued: 3 },
    },
    '../data/runningInstance': {
      RunningInstanceModel: {
        findAll: async (options) => {
          instanceReads.push(options);
          return [{ id: 7 }];
        },
        update: async (...args) => instanceWrites.push(args),
      },
      InstanceStatus: { running: 0, stopped: 2 },
    },
    dayjs: () => ({ unix: () => 123 }),
    './childProcess': {
      observeChildProcess: () => ({ completed: Promise.resolve({ code: 0 }) }),
      asError: (e) => e,
    },
  });
  return {
    run: () => runCron('task example.py', { id: '1' }),
    spawned,
    cronWrites,
    instanceWrites,
    instanceReads,
  };
}

function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

test('running single-instance task stays untouched while its process is alive', async () => {
  const f = fixture({
    allow_multiple_instances: 0,
    pid: process.pid,
    status: 0,
  });
  await f.run();
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.cronWrites, []);
  assert.deepEqual(f.instanceWrites, []);
});

test('queued single-instance task keeps its reservation even with an exited PID', async () => {
  const f = fixture({
    allow_multiple_instances: 0,
    pid: exitedPid(),
    status: 3,
  });
  await f.run();
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.cronWrites, []);
  assert.deepEqual(f.instanceWrites, []);
});

test('exited running task is recovered and the next trigger sees the new active run', async () => {
  const oldPid = exitedPid();
  const f = fixture(
    {
      allow_multiple_instances: 0,
      pid: oldPid,
      status: 0,
      log_path: 'old.log',
      queued_token: 'old-token',
      last_execution_time: 10,
      isDisabled: 0,
    },
    {
      onSpawn: (row) => {
        row.status = 0;
        row.pid = process.pid;
      },
    },
  );
  await f.run();
  await f.run();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(f.instanceReads, [
    {
      attributes: ['id'],
      where: { cron_id: 1, pid: oldPid, status: 0 },
    },
  ]);
  assert.deepEqual(f.cronWrites, [
    [
      { status: 1, pid: null, queued_token: null },
      {
        where: {
          id: 1,
          pid: oldPid,
          status: 0,
          log_path: 'old.log',
          queued_token: 'old-token',
          last_execution_time: 10,
          isDisabled: 0,
          allow_multiple_instances: 0,
        },
      },
    ],
  ]);
  assert.deepEqual(f.instanceWrites, [
    [{ status: 2, finished_at: 123 }, { where: { id: [7], status: 0 } }],
  ]);
});

test('a lost stale-state claim does not spawn or change running instances', async () => {
  const f = fixture(
    { allow_multiple_instances: 0, pid: exitedPid(), status: 0 },
    { claim: false },
  );
  await f.run();
  assert.equal(f.cronWrites.length, 1);
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.instanceWrites, []);
});

test('EPERM means an existing process must still block a new run', async () => {
  const pid = exitedPid();
  const originalKill = process.kill;
  process.kill = (target, signal) => {
    if (target === pid && signal === 0)
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return originalKill(target, signal);
  };
  try {
    const f = fixture({ allow_multiple_instances: 0, pid, status: 0 });
    await f.run();
    assert.deepEqual(f.spawned, []);
    assert.deepEqual(f.cronWrites, []);
  } finally {
    process.kill = originalKill;
  }
});

test('single-instance still starts idle tasks with a stale stored PID', async () => {
  const f = fixture({
    allow_multiple_instances: 0,
    pid: exitedPid(),
    status: 1,
  });
  await f.run();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(f.cronWrites, []);
});

test('multi-instance keeps its existing concurrent execution behavior', async () => {
  const f = fixture({
    allow_multiple_instances: 1,
    pid: process.pid,
    status: 0,
  });
  await f.run();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(f.cronWrites, []);
});
