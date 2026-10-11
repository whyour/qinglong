const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');

const logger = { info() {}, error() {} };

function cronFixture(killTask) {
  const events = [];
  const { runCron } = load('back/shared/runCron.ts', {
    'cross-spawn': {
      spawn: () => {
        events.push('spawn');
        return {};
      },
    },
    './childProcess': {
      observeChildProcess: () => ({ completed: Promise.resolve({ code: 0 }) }),
      asError: (e) => e,
    },
    './pLimit': {
      runWithCronLimit: async (_, fn) => fn(),
      removeQueuedCron: () => events.push('release'),
    },
    '../loaders/logger': logger,
    '../config/util': { killTask },
    '../data/cron': {
      CrontabModel: {
        findOne: async () => ({
          pid: 100,
          status: 0,
          allow_multiple_instances: 0,
        }),
        update: async () => events.push('idle'),
      },
      CrontabStatus: { running: 0, idle: 1, queued: 3 },
    },
    '../data/runningInstance': {
      RunningInstanceModel: { update: async () => events.push('stopped') },
      InstanceStatus: { running: 0, stopped: 2 },
    },
  });
  return { run: () => runCron('ignored', { id: '1' }), events };
}

test('single-instance replacement does not spawn or finalize when termination fails', async () => {
  const f = cronFixture(async () => {
    throw Error('EPERM');
  });
  await f.run();
  assert.deepEqual(f.events, ['release']);
});

test('single-instance replacement waits for verified exit before spawning', async () => {
  let finish, entered, verified;
  const pending = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = cronFixture(async (pid, wait) => {
    assert.equal(pid, 100);
    verified = wait;
    entered();
    await gate;
  });
  const running = f.run();
  await pending;
  assert.deepEqual(f.events, []);
  finish();
  await running;
  assert.equal(verified, true);
  assert.deepEqual(f.events, ['stopped', 'idle', 'spawn', 'release']);
});

function subscriptionFixture(killTask) {
  const updates = [];
  const Service = load('back/services/subscription.ts', {
    '../config': {},
    '../data/cron': {},
    '../config/const': {},
    '../data/subscription': {
      SubscriptionModel: {
        findAll: async () => [
          { id: 1, pid: 101 },
          { id: 2, pid: 102 },
        ],
        update: async (values, query) => updates.push({ values, query }),
      },
      SubscriptionStatus: { idle: 1 },
    },
    '../config/util': { killTask },
    '../config/subscription': {},
    '../shared/i18n': {},
    '../shared/pLimit': {},
    '../shared/logReader': {},
    '../shared/logStreamManager': {},
    './schedule': {},
    './sock': {},
    './sshKey': {},
    './cron': {},
  }).default;
  return { service: new Service(logger, {}, {}, {}, {}), updates };
}

test('batch subscription stop preserves failed items and reports failure while stopping others', async () => {
  const calls = [];
  const denied = Error('EPERM');
  const f = subscriptionFixture(async (pid, wait) => {
    calls.push([pid, wait]);
    if (pid === 101) throw denied;
  });
  await assert.rejects(f.service.stop([1, 2]), (e) => e === denied);
  assert.deepEqual(calls, [
    [101, true],
    [102, true],
  ]);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].query.where.id, 2);
  assert.equal(f.updates[0].values.status, 1);
});

function scriptFixture(killTask, pid = 100) {
  const Service = load('back/services/script.ts', {
    '../config': { scriptPath: '/scripts' },
    '../config/const': { TASK_COMMAND: 'task' },
    '../config/util': { killTask, getPid: async () => pid },
    '../shared/pLimit': { removeQueuedCron() {} },
    './sock': {},
    './cron': {},
    './schedule': {},
    '../shared/fileAccess': {},
  }).default;
  return new Service(logger, {}, {}, {});
}

test('script stop propagates failure instead of returning success', async () => {
  const denied = Error('EPERM');
  const service = scriptFixture(async () => {
    throw denied;
  });
  await assert.rejects(
    service.stopScript('/scripts/test.js', 100),
    (e) => e === denied,
  );
});

test('script stop verifies exit and treats an absent queued process as already stopped', async () => {
  const calls = [];
  const service = scriptFixture(async (...args) => calls.push(args), undefined);
  assert.equal((await service.stopScript('/scripts/test.js', 100)).code, 200);
  assert.deepEqual(calls, [[100, true]]);
  const absent = scriptFixture(async () => assert.fail('no PID to stop'), null);
  assert.equal(
    (await absent.stopScript('/scripts/test.js', undefined)).code,
    200,
  );
});
