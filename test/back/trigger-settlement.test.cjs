const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const { installTriggerHistory } = require('../../back/cron/history');
const {
  TriggerLifecycle,
} = require('../../back/cron/execution/triggerLifecycle');
const {
  TriggerSettlement,
} = require('../../back/cron/settlement/triggerSettlement');
const {
  readExit,
  writeExit,
  receiptPath,
} = require('../../back/cron/settlement/exitReceipt.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-settlement-'));
  const db = load('back/data/index.ts', {
    '../config/index': { dbPath: root },
  }).sequelize;
  const models = load('back/data/cron.ts', { './index': { sequelize: db } });
  const instances = load('back/data/runningInstance.ts', {
    './index': { sequelize: db },
  });
  load('back/data/cronStats.ts', { './index': { sequelize: db } });
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
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    allow_multiple_instances: 1,
  });
  // Compose the two modules directly, without a TriggerHistory instance.
  function components() {
    let lifecycle;
    const settlement = new TriggerSettlement(db, {
      finish: (...args) => lifecycle.finish(...args),
      shouldStop: (...args) => lifecycle.shouldStop(...args),
    });
    lifecycle = new TriggerLifecycle(db, settlement);
    return { lifecycle, settlement };
  }
  const { lifecycle, settlement } = components();
  const start = new Date().setHours(0, 0, 0, 0) - 60_000;
  async function seed(id) {
    await lifecycle.enqueue(id, 1, 'manual', null, start);
    assert.equal(await lifecycle.start(id, start, true), true);
    assert.equal(
      await lifecycle.bindCommand(id, process.pid, id + '.log'),
      true,
    );
  }
  const rows = () =>
    db.query('SELECT * FROM CronTriggers ORDER BY id', {
      type: QueryTypes.SELECT,
    });
  const stats = () =>
    db.query(
      'SELECT run_count,success_count,fail_count,total_time,max_time FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
  return {
    db,
    seed,
    start,
    lifecycle,
    settlement,
    components,
    rows,
    stats,
    instances,
  };
}

test('caller rollback preserves exit evidence, state and statistics; a fresh settlement books the replay once', async (t) => {
  const { db, seed, start, settlement, components, rows, stats, instances } =
    await fixture(t);
  await seed('rollback');
  writeExit('rollback', 17, null, start + 1000);
  await assert.rejects(
    db.transaction(async (tx) => {
      await settlement.completeCommandExit('rollback', 'finished', null, 0, tx);
      const [row] = await db.query('SELECT counted FROM CronTriggers', {
        transaction: tx,
        type: QueryTypes.SELECT,
      });
      assert.equal(row.counted, 1);
      throw Error('caller rollback');
    }),
    /caller rollback/,
  );
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [['running', null, 0]],
  );
  assert.deepEqual(await stats(), []);
  assert.equal((await instances.RunningInstanceModel.findOne()).status, 0);
  assert.equal((await readExit('rollback')).code, 17);

  const restarted = components().settlement;
  await db.transaction((tx) => restarted.replayPublishedExits(tx));
  writeExit('rollback', 17, null, start + 1000);
  await restarted.retryPendingExits();
  await restarted.complete('rollback', 'finished', null, 0);
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [['failed', 17, 1]],
  );
  assert.deepEqual(await stats(), [
    {
      run_count: 1,
      success_count: 0,
      fail_count: 1,
      total_time: 1000,
      max_time: 1000,
    },
  ]);
  assert.equal((await instances.RunningInstanceModel.findOne()).status, 3);
  assert.equal(await readExit('rollback'), undefined);
});

test('failed COMMIT keeps the receipt despite afterCommit hooks and allows exactly one later booking', async (t) => {
  const { db, seed, start, settlement, rows, stats } = await fixture(t);
  await seed('commit-failure');
  writeExit('commit-failure', 0, null, start + 2000);
  await db.query('CREATE TABLE required_parent(id INTEGER PRIMARY KEY)');
  await db.query(
    'CREATE TABLE deferred_child(id INTEGER REFERENCES required_parent(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await db.query(
    'CREATE TRIGGER fail_settlement_commit AFTER INSERT ON CrontabStats BEGIN INSERT INTO deferred_child VALUES (1); END',
  );
  await assert.rejects(
    settlement.complete('commit-failure', 'failed', null, 1),
    /constraint|foreign key/i,
  );
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.counted]),
    [['running', 0]],
  );
  assert.deepEqual(await stats(), []);
  assert.equal((await readExit('commit-failure')).code, 0);
  await db.query('DROP TRIGGER fail_settlement_commit');
  await settlement.complete('commit-failure', 'unknown', 'restart', null);
  await settlement.complete('commit-failure', 'unknown', 'restart', null);
  assert.deepEqual(await stats(), [
    {
      run_count: 1,
      success_count: 1,
      fail_count: 0,
      total_time: 2000,
      max_time: 2000,
    },
  ]);
  assert.equal(await readExit('commit-failure'), undefined);
});

for (const conflict of ['code', 'time']) {
  test(`conflicting bound ${conflict} withdraws only its own booking and remains unknown through replay`, async (t) => {
    const { seed, start, lifecycle, settlement, rows, stats, db } =
      await fixture(t);
    for (const [id, duration] of [
      ['disputed', 3000],
      ['sibling', 1000],
    ]) {
      await seed(id);
      writeExit(id, 0, null, start + duration);
      await settlement.complete(id, 'finished', null, 0);
    }
    writeExit(
      'disputed',
      conflict === 'code' ? 23 : 0,
      null,
      start + (conflict === 'time' ? 4000 : 3000),
    );
    await settlement.retryPendingExits();
    await settlement.retryPendingExits();
    await settlement.recordShellResult('disputed', 1, 0, 3000, start + 3000);
    assert.deepEqual(
      (await rows()).map((r) => [r.id, r.state, r.exit_code, r.counted]),
      [
        ['disputed', 'unknown', null, 0],
        ['sibling', 'finished', 0, 1],
      ],
    );
    assert.deepEqual(await stats(), [
      {
        run_count: 1,
        success_count: 1,
        fail_count: 0,
        total_time: 1000,
        max_time: 1000,
      },
    ]);
    assert.equal(
      await lifecycle.enqueue('disputed', 1, 'recovery', null, start + 5000),
      false,
    );
    const conflicts = await db.query('SELECT * FROM CronBoundExitConflicts', {
      type: QueryTypes.SELECT,
    });
    assert.equal(conflicts.length, 2);
    assert.ok(
      await readExit('disputed'),
      'conflicting durable evidence must remain available',
    );
  });
}

test('a damaged receipt stays unknown and uncounted until verified evidence repairs the result', async (t) => {
  const { seed, start, lifecycle, settlement, rows, stats } = await fixture(t);
  await seed('damaged');
  const file = receiptPath('damaged');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"version":1');
  await settlement.complete(
    'damaged',
    'finished',
    null,
    0,
    start + 1000,
    'legacy',
  );
  await settlement.retryPendingExits();
  assert.deepEqual(
    (await rows()).map((r) => [
      r.state,
      r.exit_code,
      r.counted,
      r.exit_pending,
    ]),
    [['unknown', null, 0, 1]],
  );
  assert.deepEqual(await stats(), []);
  assert.equal(
    await lifecycle.enqueue('damaged', 1, 'recovery', null, start + 2000),
    false,
  );
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":1');
  await fs.unlink(file);
  writeExit('damaged', 23, null, start + 1000);
  await settlement.retryPendingExits();
  await settlement.retryPendingExits();
  assert.deepEqual(
    (await rows()).map((r) => [r.state, r.exit_code, r.counted]),
    [['failed', 23, 1]],
  );
  assert.deepEqual(await stats(), [
    {
      run_count: 1,
      success_count: 0,
      fail_count: 1,
      total_time: 1000,
      max_time: 1000,
    },
  ]);
});
