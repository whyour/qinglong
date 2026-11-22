const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
async function fixture(t, onKill = async () => {}) {
  const logPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-stop-log-'));
  t.after(() => fs.rmSync(logPath, { recursive: true, force: true }));
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const crons = db.define('Crontab', {
    command: DataTypes.STRING,
    status: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    log_path: DataTypes.STRING,
    queued_token: DataTypes.STRING,
    last_execution_time: DataTypes.INTEGER,
    last_instance_id: DataTypes.INTEGER,
    last_running_time: DataTypes.INTEGER,
  });
  const instances = db.define('RunningInstance', {
    cron_id: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    status: DataTypes.INTEGER,
    exit_code: DataTypes.INTEGER,
    finished_at: DataTypes.INTEGER,
    started_at: { type: DataTypes.INTEGER, defaultValue: 100 },
    log_path: { type: DataTypes.STRING, defaultValue: 'one.log' },
  });
  load('back/data/cronStats.ts', { '.': { sequelize: db } });
  await db.sync();
  await db.transaction((tx) =>
    require('../../back/cron/history').installTriggerHistory(db, tx),
  );
  await crons.bulkCreate([
    { id: 1, command: 'task one.js', status: 0, pid: 101, log_path: 'one.log' },
    { id: 2, command: 'task two.js', status: 0, pid: 201, log_path: 'two.log' },
  ]);
  await instances.bulkCreate([
    { id: 1, cron_id: 1, pid: 101, status: 0 },
    { id: 2, cron_id: 1, pid: 102, status: 0 },
    { id: 3, cron_id: 1, pid: 99, status: 1, exit_code: 0 },
    { id: 4, cron_id: 1, pid: 98, status: 3, exit_code: 7 },
    { id: 5, cron_id: 2, pid: 201, status: 0 },
  ]);
  let service;
  const killed = [];
  const CronService = load(path.resolve('back/services/cron.ts'), {
    '../config': { logPath },
    '../data/cron': {
      CrontabModel: crons,
      CrontabStatus: { queued: 3, running: 0, idle: 1 },
    },
    '../data/runningInstance': {
      RunningInstanceModel: instances,
      InstanceStatus: { running: 0, finished: 1, stopped: 2, error: 3 },
    },
    '../cron/execution/cronProcess': {
      pidNamespaceOwner: require('../../back/cron/execution/cronProcess')
        .pidNamespaceOwner,
      verifyCronProcess() {},
    },
    '../config/util': {
      killTask: async (pid, wait) => {
        assert.equal(wait, true);
        killed.push(pid);
        await onKill({ pid, service, instances, crons });
      },
      killAllTasks: async () => {
        throw Error('command-wide scans must not run');
      },
    },
    '../config/const': {},
    '../schedule/client': {},
    '../cron/execution/cronLimit': {},
    '../shared/utils': {},
    '../shared/i18n': { t: (s) => s },
    '../shared/logReader': {},
    '../shared/logStreamManager': {},
    '../shared/childProcess': require('../../back/shared/childProcess'),
  }).default;
  service = new CronService({ info() {}, error() {} });
  service.getDb = ({ id }) => crons.findByPk(id);
  return { service, instances, crons, killed };
}
async function report(service, pid, code) {
  await service.status({
    ids: [1],
    status: 1,
    pid,
    log_path: 'one.log',
    last_running_time: 1,
    last_execution_time: 100,
    exit_code: code,
  });
}
test('batch stop preserves a legacy exit already settled during termination', async (t) => {
  const f = await fixture(t, async ({ service }) => {
    await report(service, 101, 143);
    await report(service, 102, 0);
  });
  await f.service.stop([1]);
  const rows = await f.instances.findAll({ order: [['id', 'ASC']], raw: true });
  assert.deepEqual(
    rows.map((r) => [r.id, r.status, r.exit_code]),
    [
      [1, 3, 143],
      [2, 1, 0],
      [3, 1, 0],
      [4, 3, 7],
      [5, 0, null],
    ],
  );
});
test('late shell completion cannot overwrite stopped instances', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1]);
  await report(f.service, 101, 143);
  assert.equal((await f.instances.findByPk(1)).status, 2);
  assert.equal((await f.instances.findByPk(2)).status, 2);
});
test('rows created after the stop snapshot are not relabelled', async (t) => {
  const f = await fixture(t, async ({ instances }) => {
    if (!(await instances.findByPk(6)))
      await instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
  });
  await f.service.stop([1]);
  assert.equal((await f.instances.findByPk(6)).status, 0);
  assert.equal((await f.instances.findByPk(1)).status, 2);
});
test('repeated stop does not rewrite historical rows or their finished timestamps', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1]);
  const before = await f.instances.findAll({
    raw: true,
    order: [['id', 'ASC']],
  });
  await f.service.stop([1]);
  assert.deepEqual(
    await f.instances.findAll({ raw: true, order: [['id', 'ASC']] }),
    before,
  );
});
test('batch stop captures running instances from every requested cron', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1, 2]);
  assert.equal((await f.instances.findByPk(5)).status, 2);
  assert.equal((await f.instances.findByPk(3)).status, 1);
});

test('stop signals every snapshotted PID exactly once and preserves a later running instance', async (t) => {
  const f = await fixture(t, async ({ instances, crons }) => {
    if (!(await instances.findByPk(6))) {
      await instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
      await crons.update(
        { pid: 103, log_path: 'later.log', status: 0 },
        { where: { id: 1 } },
      );
    }
  });
  await f.service.stop([1]);
  assert.deepEqual(f.killed, [101, 102]);
  assert.equal((await f.instances.findByPk(6)).status, 0);
  assert.equal((await f.crons.findByPk(1)).pid, 103);
  assert.equal((await f.crons.findByPk(1)).status, 0);
});

test('failed termination is not finalized as stopped', async (t) => {
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 102) throw Error('still alive');
  });
  await assert.rejects(f.service.stop([1]), /still alive/);
  assert.deepEqual(f.killed, [101, 102]);
  assert.equal((await f.instances.findByPk(1)).status, 2);
  assert.equal((await f.instances.findByPk(2)).status, 0);
  assert.equal((await f.crons.findByPk(1)).status, 0);
});

test('stop instance verifies cron ownership, waits for exit and never confirms a failed signal', async (t) => {
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 102) throw Error('still alive');
  });
  assert.equal((await f.service.stopInstance(2, 1)).code, 404);
  await f.instances.create({ id: 6, cron_id: 1, status: 0, pid: null });
  assert.equal((await f.service.stopInstance(1, 6)).code, 409);
  assert.deepEqual(f.killed, []);
  await assert.rejects(f.service.stopInstance(1, 2), /still alive/);
  assert.equal((await f.instances.findByPk(2)).status, 0);
  assert.equal((await f.service.stopInstance(1, 1)).code, 200);
  assert.equal((await f.service.stopInstance(1, 1)).data.outcome, 'stopped');
  assert.equal((await f.instances.findByPk(1)).status, 2);
});

test('legacy instances sharing a numeric PID cannot be individually signalled', async (t) => {
  const f = await fixture(t);
  await f.instances.create({ id: 6, cron_id: 1, pid: 101, status: 0 });
  assert.equal((await f.service.stopInstance(1, 1)).code, 409);
  assert.deepEqual(f.killed, []);
  assert.equal((await f.instances.findByPk(6)).status, 0);
});

test('concurrent single stops join only the same task and instance; failures release a retry', async (t) => {
  let release,
    entered,
    fail = true;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 101 && fail) {
      entered();
      await gate;
      throw Error('denied');
    }
  });
  const first = f.service.stopInstance(1, 1);
  const duplicates = Array.from({ length: 8 }, () =>
    f.service.stopInstance(1, 1),
  );
  await waiting;
  assert.equal((await f.service.stopInstance(2, 1)).code, 404);
  assert.equal((await f.instances.findByPk(2)).status, 0);
  assert.deepEqual(f.killed, [101]);
  fail = false;
  release();
  for (const r of await Promise.allSettled([first, ...duplicates]))
    assert.match(r.reason.message, /denied/);
  const second = await Promise.all([
    f.service.stopInstance(1, 1),
    f.service.stopInstance(1, 1),
  ]);
  assert.deepEqual(
    second.map((r) => r.data.outcome),
    ['stopped', 'stopped'],
  );
  assert.deepEqual(f.killed, [101, 101]);
  assert.equal((await f.service.stopInstance(1, 3)).data.outcome, 'ended');
  assert.equal((await f.instances.findByPk(3)).exit_code, 0);
});

test('single and batch stop share the in-flight termination and keep the batch snapshot across retries', async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const firstSignal = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 101) {
      entered();
      await gate;
    }
  });
  const single = f.service.stopInstance(1, 1);
  await firstSignal;
  let captured;
  const batchJoined = new Promise((resolve) => {
    captured = resolve;
  });
  const stopInstance = f.service.stopInstance.bind(f.service);
  f.service.stopInstance = (cronId, id) => {
    if (id === 1) captured();
    return stopInstance(cronId, id);
  };
  const bulk = f.service.stop([1]);
  await batchJoined;
  const history = new (require('../../back/cron/history').TriggerHistory)(
    f.crons.sequelize,
  );
  assert.deepEqual(
    (await history.pendingStops()).map((r) => r.instance_id),
    [1, 2],
  );
  await f.instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
  const duplicate = stopInstance(1, 1);
  release();
  await Promise.all([single, bulk, duplicate]);
  assert.deepEqual(f.killed, [101, 102]);
  assert.deepEqual(
    (await f.instances.findAll({ order: [['id', 'ASC']] })).map(
      (r) => r.status,
    ),
    [2, 2, 1, 3, 0, 0],
  );
  assert.deepEqual(await history.pendingStops(), []);
});

test('a single stop is durable before asynchronous tree traversal and a replacement worker resumes it', async (t) => {
  let interrupted = true;
  const f = await fixture(t, async () => {
    if (interrupted) throw Error('interrupted while enumerating tree');
  });
  await assert.rejects(f.service.stopInstance(1, 2), /interrupted/);
  const history = new (require('../../back/cron/history').TriggerHistory)(
    f.crons.sequelize,
  );
  const pending = await history.pendingStops();
  assert.deepEqual(
    pending.map((r) => [r.cron_id, r.instance_id, r.pid, r.targets]),
    [[1, 2, 102, null]],
  );
  interrupted = false;
  const replacement = new f.service.constructor({ error() {}, warn() {} });
  await replacement.resumePendingStops(history, pending);
  assert.equal((await f.instances.findByPk(2)).status, 2);
  assert.deepEqual(await history.pendingStops(), []);
  assert.equal((await f.instances.findByPk(1)).status, 0);
});

test('an interrupted batch replays its original instances and leaves later queued and live runs alone', async (t) => {
  let blocked = true;
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 102 && blocked) throw Error('interrupted');
  });
  const history = new (require('../../back/cron/history').TriggerHistory)(
    f.crons.sequelize,
  );
  const key = require('node:crypto').randomUUID();
  await history.enqueue('before', 1, 'manual', null);
  await assert.rejects(f.service.stop([1], key), /interrupted/);
  const pending = await history.pendingStopBatches();
  assert.deepEqual(pending, [{ request_id: key, cron_ids: '[1]' }]);
  await history.enqueue('after', 1, 'manual', null);
  await f.instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
  await f.crons.update(
    { status: 3, queued_token: 'later' },
    { where: { id: 1 } },
  );
  blocked = false;
  const replacement = () =>
    new f.service.constructor({ warn() {}, error() {} });
  await replacement().resumePendingStops(
    history,
    await history.pendingStops(),
    pending,
  );
  await replacement().resumePendingStops(history, [], pending);
  await replacement().stop([1, 1], key);
  await assert.rejects(replacement().stop([2], key), { status: 409 });
  assert.deepEqual(f.killed, [101, 102, 102]);
  assert.deepEqual(await history.pendingStopBatches(), []);
  assert.equal((await f.instances.findByPk(6)).status, 0);
  assert.equal((await f.crons.findByPk(1)).queued_token, 'later');
  const rows = await history.recent(1, 0);
  assert.equal(rows.find((r) => r.id === 'before').state, 'stopped');
  assert.equal(rows.find((r) => r.id === 'after').state, 'queued');
  await replacement().stop([1], require('node:crypto').randomUUID());
  assert.equal((await f.instances.findByPk(6)).status, 2);
  assert.equal(
    (await history.recent(1, 0)).find((r) => r.id === 'after').state,
    'stopped',
  );
});

test('replaying an empty original snapshot never targets the first later run', async (t) => {
  const f = await fixture(t);
  const key = require('node:crypto').randomUUID();
  await f.service.stop([3], key);
  await f.crons.create({ id: 3, status: 0, pid: 301 });
  await f.instances.create({ cron_id: 3, pid: 301, status: 0 });
  await f.service.stop([3], key);
  assert.deepEqual(f.killed, []);
  await f.service.stop([3]);
  assert.deepEqual(f.killed, [301]);
});

test('a second restart rolls back receipt deletion when settling a legacy instance fails', async (t) => {
  const f = await fixture(t);
  const history = new (require('../../back/cron/history').TriggerHistory)(
    f.crons.sequelize,
  );
  await history.queueInstanceStop(1, 1, 101);
  const stop = () => f.service.stopInstance(1, 1);
  const transactionError = () => {
    throw Error('interrupted during settlement');
  };
  f.instances.addHook('beforeBulkUpdate', 'crash', transactionError);
  await assert.rejects(stop(), /interrupted during settlement/);
  f.instances.removeHook('beforeBulkUpdate', 'crash');
  assert.equal((await history.pendingStops())[0].instance_id, 1);
  await f.service.resumePendingStops(history, await history.pendingStops());
  assert.equal((await f.instances.findByPk(1)).status, 2);
  assert.deepEqual(await history.pendingStops(), []);
});

test('simultaneous first submissions share a partial failure, then retry only the original instances', async (t) => {
  let entered,
    release,
    fail = true;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 102 && fail) {
      entered();
      await gate;
      throw Error('partial failure');
    }
  });
  const key = require('node:crypto').randomUUID();
  const calls = Array.from({ length: 6 }, (_, i) =>
    f.service.stop(i % 2 ? [1, 1] : [1], key),
  );
  const results = Promise.allSettled(calls);
  await reached;
  await assert.rejects(f.service.stop([2], key), { status: 409 });
  await f.instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
  release();
  for (const result of await results)
    assert.match(result.reason.message, /partial failure/);
  assert.deepEqual(f.killed, [101, 102]);
  fail = false;
  const replacement = new f.service.constructor({ error() {}, warn() {} });
  await Promise.all([
    replacement.stop([1], key),
    replacement.stop([1, 1], key),
  ]);
  assert.deepEqual(f.killed, [101, 102, 102]);
  assert.equal((await f.instances.findByPk(6)).status, 0);
  assert.equal((await f.instances.findByPk(5)).status, 0);
});

test('a legacy task pointing to a different task’s PID cannot consume its stop result', async (t) => {
  const f = await fixture(t);
  await f.crons.create({ id: 3, status: 0, pid: 101 });
  const key = require('node:crypto').randomUUID();
  await assert.rejects(f.service.stop([1, 3], key), { status: 409 });
  assert.deepEqual(f.killed, [101, 102]);
  assert.equal((await f.crons.findByPk(3)).status, 0);
  assert.equal((await f.crons.findByPk(1)).status, 1);
  await f.instances.create({ cron_id: 1, pid: 103, status: 0 });
  await assert.rejects(f.service.stop([3, 1], key), { status: 409 });
  assert.deepEqual(f.killed, [101, 102]);
});
