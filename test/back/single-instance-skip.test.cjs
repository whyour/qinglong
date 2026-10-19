const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');

function fixture(row) {
  const spawned = [], killed = [], writes = [];
  const { runCron } = load('back/shared/runCron.ts', {
    './i18n': { t: s => s },
    'cross-spawn': { spawn: cmd => { spawned.push(cmd); return { pid: 50 }; } },
    './pLimit': {
      runWithCronLimit: (_cron, execute) => execute(),
      removeQueuedCron() {},
    },
    '../loaders/logger': { info() {}, error() {} },
    '../data/cron': {
      CrontabModel: { findOne: async () => row, update: async (...args) => writes.push(args) },
      CrontabStatus: { running: 0, idle: 1, queued: 3 },
    },
    '../config/util': { killTask: async pid => killed.push(pid) },
    '../data/runningInstance': {
      RunningInstanceModel: { update: async (...args) => writes.push(args) },
      InstanceStatus: { running: 0, stopped: 2 },
    },
    dayjs: () => ({ unix: () => 0 }),
    './childProcess': {
      observeChildProcess: () => ({ completed: Promise.resolve({ code: 0 }) }),
      asError: e => e,
    },
  });
  return { run: () => runCron('task example.py', { id: '1' }), spawned, killed, writes };
}

for (const status of [0, 3]) {
  test(`single-instance skips a busy task (status=${status}) without killing it`, async () => {
    const f = fixture({ allow_multiple_instances: 0, pid: 42, status });
    await f.run();
    assert.deepEqual(f.spawned, []);
    assert.deepEqual(f.killed, []);
    assert.deepEqual(f.writes, []);
  });
}

test('single-instance still starts idle tasks with a stale stored PID', async () => {
  const f = fixture({ allow_multiple_instances: 0, pid: 42, status: 1 });
  await f.run();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(f.killed, []);
});

test('multi-instance keeps its existing concurrent execution behavior', async () => {
  const f = fixture({ allow_multiple_instances: 1, pid: 42, status: 0 });
  await f.run();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(f.killed, []);
});
