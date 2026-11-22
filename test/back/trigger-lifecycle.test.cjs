const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const { installTriggerHistory } = require('../../back/cron/history');
const {
  TriggerLifecycle,
} = require('../../back/cron/execution/triggerLifecycle');

async function fixture(t) {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const tasks = load('back/data/cron.ts', { './index': { sequelize: db } });
  const instances = load('back/data/runningInstance.ts', {
    './index': { sequelize: db },
  });
  load('back/data/cronStats.ts', { './index': { sequelize: db } });
  await db.sync();
  await db.transaction((tx) => installTriggerHistory(db, tx));
  await tasks.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  const unexpected = async () =>
    assert.fail('unexpected exit evidence operation');
  const evidence = {
    exitBeforeStop: unexpected,
    completeCommandExit: unexpected,
    recoverScriptSample: unexpected,
    // This fixture has no receipts to replay, but recovery must pass its transaction.
    replayPublishedExits: async (tx) => assert.ok(tx && !tx.finished),
  };
  const lifecycle = new TriggerLifecycle(db, evidence);
  const rows = () =>
    db.query('SELECT * FROM CronTriggers ORDER BY id', {
      type: QueryTypes.SELECT,
    });
  return { db, lifecycle, evidence, rows, instances };
}

test('lifecycle admission, start and terminal writes roll back with the caller transaction', async (t) => {
  const { db, lifecycle, rows } = await fixture(t);
  await assert.rejects(
    db.transaction(async (tx) => {
      assert.equal(
        await lifecycle.enqueue('rolled-back', 1, 'manual', null, 100, tx),
        true,
      );
      assert.equal(await lifecycle.start('rolled-back', 200, false, tx), true);
      await lifecycle.finish('rolled-back', 'failed', 'spawn', 1, tx, 300);
      throw Error('caller rollback');
    }),
    /caller rollback/,
  );
  assert.deepEqual(await rows(), []);

  await lifecycle.enqueue('queued', 1, 'manual', null, 100);
  await lifecycle.enqueue('claimed', 1, 'manual', null, 100);
  await lifecycle.start('claimed', 200);
  await assert.rejects(
    db.transaction(async (tx) => {
      assert.deepEqual(await lifecycle.cancelQueuedInTransaction([1], tx), [
        'queued',
      ]);
      await lifecycle.queueInstanceStop(10, 1, 12345, tx);
      throw Error('stop snapshot rollback');
    }),
    /stop snapshot rollback/,
  );
  assert.deepEqual(
    (await rows()).map((row) => [row.id, row.state, row.stop_requested]),
    [
      ['claimed', 'running', null],
      ['queued', 'queued', null],
    ],
  );
  assert.deepEqual(await lifecycle.pendingStops(), []);
});

test('restart recovery requeues only unstarted slots and leaves unknown and terminal results deduplicated', async (t) => {
  const { lifecycle, rows } = await fixture(t);
  assert.equal(await lifecycle.enqueue('uncertain', 1, 'node', 100, 100), true);
  assert.equal(
    await lifecycle.enqueue('uncertain', 1, 'node', 100, 100),
    false,
  );
  assert.equal(await lifecycle.start('uncertain', 200), true);
  await lifecycle.enqueue('unstarted', 1, 'node', 100, 100);
  await lifecycle.interrupt(process.env.SERVICE_TYPE || 'http');
  assert.deepEqual(
    (await rows()).map((row) => [row.id, row.state, row.reason, row.exit_code]),
    [
      ['uncertain', 'unknown', 'restart', null],
      ['unstarted', 'skipped', 'restart', null],
    ],
  );
  assert.equal(
    await lifecycle.enqueue('uncertain', 1, 'recovery', 100, 300),
    false,
  );
  assert.equal(await lifecycle.start('uncertain', 300), false);
  assert.equal(
    await lifecycle.enqueue('unstarted', 1, 'recovery', 100, 300),
    true,
  );
  assert.equal(
    await lifecycle.enqueue('unstarted', 1, 'recovery', 100, 300),
    false,
  );
  assert.equal(await lifecycle.start('unstarted', 400), true);
  await lifecycle.finish('unstarted', 'finished', null, 0, undefined, 500);
  assert.equal(
    await lifecycle.enqueue('unstarted', 1, 'recovery', 100, 600),
    false,
  );
  await lifecycle.finish(
    'unstarted',
    'failed',
    'late retry',
    1,
    undefined,
    700,
  );
  const results = await rows();
  assert.deepEqual(
    results.map((row) => [row.id, row.state, row.exit_code]),
    [
      ['uncertain', 'unknown', null],
      ['unstarted', 'finished', 0],
    ],
  );
  assert.equal(results[1].finished_at, 500);
});

test('failed exit settlement preserves the durable stop snapshot and rolls back state before any signal', async (t) => {
  const { db, lifecycle, evidence, rows, instances } = await fixture(t);
  await lifecycle.enqueue('run', 1, 'manual', null, 100);
  await lifecycle.start('run', 200);
  const instance = await instances.RunningInstanceModel.create({
    cron_id: 1,
    pid: 12345,
    status: 0,
    started_at: 1,
  });
  await db.query('UPDATE CronTriggers SET instance_id=$instance WHERE id=$id', {
    bind: { instance: instance.id, id: 'run' },
  });
  evidence.exitBeforeStop = async () => ({
    canonical: {
      version: 1,
      code: 0,
      signal: null,
      time: 300,
      file: '/fixture/receipt',
    },
    recovered: [],
    published: true,
    unreadable: false,
  });
  let attempts = 0;
  evidence.completeCommandExit = async (id, state, reason, code, tx) => {
    attempts++;
    assert.equal(state, 'unknown');
    assert.ok(tx && !tx.finished);
    await lifecycle.finish(id, 'finished', null, 0, tx, 300);
    throw Error('ledger unavailable');
  };
  const targets = ['crond:12345:fixture-birth'];
  await assert.rejects(
    lifecycle.requestInstanceStop(
      instance.id,
      12345,
      () => assert.fail('must not signal before evidence is settled'),
      targets,
    ),
    /ledger unavailable/,
  );
  assert.equal(attempts, 1);
  const [row] = await rows();
  assert.equal(row.state, 'running');
  assert.equal(row.exit_code, null);
  assert.equal(row.stop_requested, null);
  const pending = await lifecycle.pendingStop(instance.id);
  assert.equal(pending.signalled, 0);
  assert.deepEqual(JSON.parse(pending.targets), targets);
});
