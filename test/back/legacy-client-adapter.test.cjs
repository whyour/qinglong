const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const { installTriggerHistory } = require('../../back/cron/history');
const {
  TriggerLifecycle,
} = require('../../back/cron/execution/triggerLifecycle');
const {
  TriggerSettlement,
} = require('../../back/cron/settlement/triggerSettlement');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-legacy-adapter-'));
  const db = load('back/data/index.ts', {
    '../config/index': { dbPath: root },
  }).sequelize;
  const { CrontabModel } = load('back/data/cron.ts', {
    '.': { sequelize: db },
  });
  const { RunningInstanceModel } = load('back/data/runningInstance.ts', {
    '.': { sequelize: db },
  });
  load('back/data/cronStats.ts', { '.': { sequelize: db } });
  for (const key of ['QL_DIR', 'QL_DATA_DIR']) {
    const previous = process.env[key];
    process.env[key] = root;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await db.sync();
  await db.transaction((tx) => installTriggerHistory(db, tx));
  const task = await CrontabModel.create({ id: 1, command: 'true', status: 1 });
  let lifecycle;
  const settlement = new TriggerSettlement(db, {
    finish: (...args) => lifecycle.finish(...args),
    shouldStop: (...args) => lifecycle.shouldStop(...args),
  });
  lifecycle = new TriggerLifecycle(db, settlement);
  const { LegacyClientAdapter } = load(
    'back/cron/compatibility/legacyClient.ts',
    {
      '../execution/cronProcess': {
        systemOwner: (pid) => 'fixture:' + pid,
        legacyProcessOwner: (pid) => 'fixture:' + pid,
        isProcessDescendant: () => false,
      },
    },
  );
  const adapter = new LegacyClientAdapter(db, lifecycle, settlement);
  const rows = () =>
    db.query('SELECT * FROM CronTriggers ORDER BY started_at,id', {
      type: QueryTypes.SELECT,
    });
  const stats = () =>
    db.query(
      'SELECT run_count,success_count,fail_count,total_time FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
  const seconds = Math.floor(Date.now() / 1000) - 30;
  return {
    db,
    adapter,
    lifecycle,
    task,
    instances: RunningInstanceModel,
    rows,
    stats,
    seconds,
  };
}

test('identified Shell admission and settlement roll back with the caller transaction', async (t) => {
  const { db, adapter, rows, stats, seconds } = await fixture(t);
  const id = 'client-' + randomUUID();
  await assert.rejects(
    db.transaction(async (tx) => {
      await adapter.shellReport(
        id,
        1,
        false,
        true,
        'client.log',
        seconds,
        undefined,
        false,
        tx,
      );
      await adapter.shellReport(
        id,
        1,
        false,
        false,
        'client.log',
        seconds,
        17,
        false,
        tx,
        2000,
        (seconds + 2) * 1000,
      );
      const [row] = await db.query('SELECT state,counted FROM CronTriggers', {
        transaction: tx,
        type: QueryTypes.SELECT,
      });
      assert.deepEqual(row, { state: 'failed', counted: 1 });
      throw Error('caller rollback');
    }),
    /caller rollback/,
  );
  assert.deepEqual(await rows(), []);
  assert.deepEqual(await stats(), []);
});

test('PID-only retries leave unknown exits uncounted and cannot overwrite the replacement execution', async (t) => {
  const { adapter, task, rows, stats, instances, seconds } = await fixture(t);
  const old = (running, code) =>
    adapter.reportLegacy(1, running, 123, 'same.log', seconds, 2, code);
  await Promise.all([old(true), old(true)]);
  await old(false);
  await old(true);
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [['unknown', null, 0]],
  );
  assert.deepEqual(await stats(), []);
  await adapter.reportLegacy(1, true, 123, 'same.log', seconds + 10, 0);
  const replacement = (await task.reload()).last_instance_id;
  await Promise.all([old(false, 17), old(false, 17)]);
  await old(false, 0);
  await old(true);
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [
      ['failed', 17, 1],
      ['running', null, 0],
    ],
  );
  assert.deepEqual(await stats(), [
    { run_count: 1, success_count: 0, fail_count: 1, total_time: 2000 },
  ]);
  assert.equal((await task.reload()).last_instance_id, replacement);
  assert.equal(task.last_execution_time, seconds + 10);
  assert.equal((await instances.findByPk(replacement)).status, 0);
});

test('failed legacy accounting rolls back the receipt and instance before retrying once', async (t) => {
  const { db, adapter, task, rows, stats, instances, seconds } = await fixture(
    t,
  );
  await adapter.reportLegacy(1, true, 123, 'legacy.log', seconds, 0);
  await db.query(
    "CREATE TRIGGER reject_legacy_stat BEFORE INSERT ON CrontabStats BEGIN SELECT RAISE(ABORT,'blocked accounting'); END",
  );
  await assert.rejects(
    adapter.reportLegacy(1, false, 123, 'legacy.log', seconds, 2, 17),
    (error) => {
      assert.match(error.original.message, /blocked accounting/);
      return true;
    },
  );
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.counted]),
    [['running', 0]],
  );
  assert.equal((await instances.findOne()).status, 0);
  assert.equal((await task.reload()).status, 0);
  assert.deepEqual(await stats(), []);
  await db.query('DROP TRIGGER reject_legacy_stat');
  await adapter.reportLegacy(1, false, 123, 'legacy.log', seconds, 2, 17);
  await adapter.reportLegacy(1, false, 123, 'legacy.log', seconds, 2, 17);
  assert.deepEqual(await stats(), [
    { run_count: 1, success_count: 0, fail_count: 1, total_time: 2000 },
  ]);
  assert.equal((await instances.findOne()).status, 3);
});

test('an exit before its identified start stays unknown until a statistics receipt resolves it once', async (t) => {
  const { adapter, task, rows, stats, instances, seconds } = await fixture(t);
  const id = 'client-' + randomUUID();
  await adapter.reportInstance(id, 1, false, 123, 'early.log', seconds, 2);
  await adapter.reportInstance(id, 1, true, 123, 'early.log', seconds, 0);
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.counted]),
    [['unknown', 0]],
  );
  assert.equal((await instances.findOne()).status, 4);
  assert.equal((await task.reload()).status, 1);
  assert.deepEqual(await stats(), []);
  await adapter.recordShellResult(id, 1, 17, 2000, Date.now());
  await adapter.recordShellResult(id, 1, 0, 2000, Date.now());
  await adapter.reportInstance(id, 1, true, 123, 'early.log', seconds, 0);
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [['failed', 17, 1]],
  );
  assert.equal(await instances.count(), 1);
  assert.equal((await instances.findOne()).status, 3);
  assert.deepEqual(await stats(), [
    { run_count: 1, success_count: 0, fail_count: 1, total_time: 2000 },
  ]);
});

test('successful wrapper reports cannot settle a managed command with an unknown result', async (t) => {
  const { adapter, lifecycle, rows, stats, seconds } = await fixture(t);
  await lifecycle.enqueue('managed', 1, 'manual', null, seconds * 1000);
  await lifecycle.start('managed', seconds * 1000);
  await lifecycle.finish('managed', 'unknown', 'restart');
  await adapter.reportInstance(
    'managed',
    1,
    false,
    123,
    'wrapper.log',
    seconds,
    2,
    0,
  );
  await adapter.recordShellResult('managed', 1, 0, 2000, Date.now());
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [['unknown', null, 0]],
  );
  assert.deepEqual(await stats(), []);
});

test('upgrade adoption preserves prior accounting and pending stops across repeated reconciliation', async (t) => {
  const { db, adapter, lifecycle, task, rows, stats, instances, seconds } =
    await fixture(t);
  const old = await instances.create({
    cron_id: 1,
    pid: 111,
    status: 1,
    started_at: seconds,
    finished_at: seconds + 2,
    exit_code: 0,
    log_path: 'old.log',
  });
  const live = await instances.create({
    cron_id: 1,
    pid: 222,
    status: 0,
    started_at: seconds,
    log_path: 'live.log',
  });
  const stopping = await instances.create({
    cron_id: 1,
    pid: 333,
    status: 0,
    started_at: seconds,
    log_path: 'stopping.log',
  });
  await task.update({ status: 0, pid: 222, log_path: 'live.log' });
  await db.models.CrontabStat.create({
    ref_id: 1,
    date: '2026-01-01',
    run_count: 1,
    success_count: 1,
    fail_count: 0,
    total_time: 2000,
  });
  await lifecycle.queueInstanceStop(stopping.id, 1, 333);
  await adapter.reconcileInstances();
  await adapter.reconcileInstances();
  const linked = await rows();
  assert.equal(linked.length, 2);
  assert.deepEqual(
    linked.find((r) => r.instance_id === old.id).state,
    'finished',
  );
  assert.equal(linked.find((r) => r.instance_id === old.id).counted, 1);
  assert.equal(linked.find((r) => r.instance_id === live.id).state, 'running');
  assert.equal((await stopping.reload()).status, 0);
  assert.ok(await lifecycle.pendingStop(stopping.id));
  assert.deepEqual(await stats(), [
    { run_count: 1, success_count: 1, fail_count: 0, total_time: 2000 },
  ]);
});
