const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const { TriggerQueries } = require('../../back/cron/queries/triggerQueries');
const {
  TriggerHistory,
  installTriggerHistory,
} = require('../../back/cron/history');

test('history queries work on a read-only database without resolving uncertain exits', async (t) => {
  // The in-memory database shares one connection, including audit snapshots,
  // so query_only prevents writes throughout the complete read path.
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  load('back/data/cron.ts', { './index': { sequelize: db } });
  load('back/data/runningInstance.ts', { './index': { sequelize: db } });
  load('back/data/cronStats.ts', { './index': { sequelize: db } });
  await db.sync();
  await db.transaction((tx) => installTriggerHistory(db, tx));
  await db.query(`INSERT INTO CronTriggers
    (id,cron_id,source,state,reason,exit_code,finished_at,exit_pending,observed_at)
    VALUES ('a-restart',1,'manual','unknown','restart',0,200,0,100),
           ('b-pending',1,'legacy','unknown','restart',0,200,1,100),
           ('c-conflict',1,'legacy','unknown','restart',0,200,1,100),
           ('d-finished',1,'manual','finished',NULL,0,200,0,100),
           ('other-task',2,'manual','finished',NULL,0,200,0,100)`);
  await db.query(`INSERT INTO CronExitObservations VALUES
    ('c-conflict','0',200), ('c-conflict','1',200)`);
  const storedRows = () =>
    db.query('SELECT * FROM CronTriggers ORDER BY id', {
      type: QueryTypes.SELECT,
    });
  const before = await storedRows();
  await db.query('PRAGMA query_only=ON');
  await assert.rejects(
    db.query("UPDATE CronTriggers SET state='finished'"),
    /readonly/i,
  );

  const queries = new TriggerQueries(db);
  const compatibility = new TriggerHistory(db);
  const ids = before.map((row) => row.id);
  const selected = await queries.visibleTriggers(1, ids);
  assert.deepEqual(
    selected.map((row) => [
      row.id,
      row.state,
      row.reason,
      row.exit_code,
      row.finished_at,
    ]),
    [
      ['a-restart', 'unknown', 'restart', null, null],
      ['b-pending', 'unknown', 'exit_pending', null, null],
      ['c-conflict', 'unknown', 'exit_conflict', null, null],
      ['d-finished', 'finished', null, 0, 200],
    ],
  );
  assert.deepEqual(await compatibility.visibleTriggers(1, ids), selected);

  const first = await queries.recent(1, 0, 2);
  assert.deepEqual(
    first.map((row) => row.id),
    ['d-finished', 'c-conflict'],
  );
  const cursor = { time: first[1].observed_at, id: first[1].id };
  const older = await queries.recent(1, 0, 2, cursor);
  assert.deepEqual(
    older.map((row) => row.id),
    ['b-pending', 'a-restart'],
  );
  assert.deepEqual(await queries.recent(1, 2, 2), older);
  assert.deepEqual(await compatibility.recent(1, 0, 2, cursor), older);

  const metrics = await queries.metrics(0);
  assert.equal(metrics.observed, 5);
  assert.equal(metrics.planned, 0);
  assert.equal(metrics.waitP95, null);
  assert.deepEqual(await compatibility.metrics(0), metrics);
  assert.deepEqual(await storedRows(), before);
});
