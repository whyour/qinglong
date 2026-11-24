const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Sequelize, QueryTypes } = require('sequelize');
const { executionModel } = require('../../back/data/executionModels');
const {
  TriggerHistory,
  installTriggerHistory,
} = require('../../back/cron/history');
const {
  GlobalCronBudget,
} = require('../../back/cron/execution/globalCronBudget');
const { QueueOccupants } = require('../../back/cron/queries/queueDiagnostics');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-orm-'));
  const storage = path.join(dir, 'db.sqlite');
  const db = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  for (const table of ['Crontabs', 'RunningInstances', 'CrontabStats', 'Auths'])
    executionModel(db, table);
  await db.sync();
  await db.transaction((transaction) => installTriggerHistory(db, transaction));
  const other = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  t.after(async () => {
    await other.close();
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { db, other };
}

test('independent worker connections map existing tables without opening another database or modifying schema', async (t) => {
  const { db, other } = await fixture(t);
  const sql = [];
  other.options.logging = (text) => sql.push(text);
  for (const table of [
    'Crontabs',
    'RunningInstances',
    'CrontabStats',
    'Auths',
    'CronTriggers',
  ])
    executionModel(other, table);
  assert.deepEqual(sql, []);
  assert.notEqual(
    executionModel(db, 'CronTriggers'),
    executionModel(other, 'CronTriggers'),
  );
  await db.query(
    "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('systemConfig','{\"cronConcurrency\":4}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  const row = await executionModel(other, 'Auths').findOne({
    attributes: ['info'],
    raw: true,
  });
  assert.deepEqual(JSON.parse(row.info), { cronConcurrency: 4 });
  assert.equal((await new GlobalCronBudget(other).snapshot()).free, 4);
});

test('ORM cancellation keeps the transaction rollback boundary and updates only eligible states', async (t) => {
  const { db, other } = await fixture(t);
  const history = new TriggerHistory(other);
  const ids = ["quote'--", 'recovery', 'finished', 'bound'];
  for (let i = 0; i < ids.length; i++)
    await db.query(
      "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,queued_at) VALUES($id,1,'node','queued',1,1)",
      { bind: { id: ids[i] } },
    );
  await db.query(
    "UPDATE CronTriggers SET state='skipped',reason='restart',resume_pending=1 WHERE id='recovery'",
  );
  await db.query(
    "UPDATE CronTriggers SET state='finished',started_at=1 WHERE id='finished'",
  );
  await db.query(
    "UPDATE CronTriggers SET state='running',command_identity='bound' WHERE id='bound'",
  );
  await assert.rejects(
    other.transaction(async (transaction) => {
      await history.cancelQueuedInTransaction([1], transaction);
      throw Error('rollback');
    }),
    /rollback/,
  );
  assert.equal(
    (
      await db.query('SELECT state FROM CronTriggers WHERE id=$id', {
        bind: { id: ids[0] },
        type: QueryTypes.SELECT,
      })
    )[0].state,
    'queued',
  );
  assert.deepEqual(
    new Set(await history.cancelQueued([1])),
    new Set(ids.slice(0, 2)),
  );
  const rows = await db.query('SELECT id,state FROM CronTriggers', {
    type: QueryTypes.SELECT,
  });
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.state])), {
    [ids[0]]: 'stopped',
    recovery: 'stopped',
    finished: 'finished',
    bound: 'running',
  });
});

test('ORM live diagnostics preserve null-safe change detection and escaped payloads', async (t) => {
  const { db } = await fixture(t);
  const id = "odd'\n--";
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,queued_at) VALUES($id,1,'manual','queued',1,1)",
    { bind: { id } },
  );
  const warnings = [];
  const pool = new QueueOccupants(
    'manual',
    () => 1,
    (error) => warnings.push(error),
  );
  pool.watch(id, db);
  // Flush deterministically; the timer is cleared when the observed wait is removed.
  await pool.flush();
  pool.forget(id);
  const [row] = await db.query(
    'SELECT queue_live_context FROM CronTriggers WHERE id=$id',
    { bind: { id }, type: QueryTypes.SELECT },
  );
  assert.equal(JSON.parse(row.queue_live_context).limit, 1);
  assert.deepEqual(warnings, []);
});
