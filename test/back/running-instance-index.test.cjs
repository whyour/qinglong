const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Sequelize, QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');

test('existing instance history gains a partial live index, with transactional visibility and rollback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-live-index-'));
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'db.sqlite'),
    logging: false,
  });
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const { RunningInstanceModel } = load('back/data/runningInstance.ts', {
    '.': { sequelize: db },
  });
  await RunningInstanceModel.sync();
  await db.query('DROP INDEX running_instances_active_cron_id');
  await db.query(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<10000)
    INSERT INTO RunningInstances(id,cron_id,pid,started_at,status,createdAt,updatedAt)
    SELECT n,1,n,n,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM seq`);
  await db.query('UPDATE RunningInstances SET status=0 WHERE id IN (1,2)');
  await db.query(
    'UPDATE RunningInstances SET cron_id=2,status=0 WHERE id=10000',
  );
  await RunningInstanceModel.sync();
  await RunningInstanceModel.sync();
  const [index] = await db.query(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='running_instances_active_cron_id'",
    { type: QueryTypes.SELECT },
  );
  assert.match(index.sql, /WHERE\s+[`"]?status[`"]?\s*=\s*0/i);
  assert.equal(await RunningInstanceModel.count(), 10000);
  const sql =
    'SELECT id,pid FROM RunningInstances WHERE cron_id=1 AND status=0 ORDER BY id DESC LIMIT 1';
  const plan = await db.query('EXPLAIN QUERY PLAN ' + sql, {
    type: QueryTypes.SELECT,
  });
  assert.ok(
    plan.some((row) => row.detail.includes('running_instances_active_cron_id')),
  );
  const read = (transaction) =>
    db.query(sql, { type: QueryTypes.SELECT, transaction });
  assert.equal((await read())[0].id, 2);
  await assert.rejects(
    db.transaction(async (transaction) => {
      await db.query('UPDATE RunningInstances SET status=3 WHERE id=2', {
        transaction,
      });
      assert.equal((await read(transaction))[0].id, 1);
      await db.query('UPDATE RunningInstances SET status=2 WHERE id=1', {
        transaction,
      });
      assert.deepEqual(await read(transaction), []);
      throw Error('rollback');
    }),
    /rollback/,
  );
  assert.equal((await read())[0].id, 2);
  await db.transaction(async (transaction) => {
    await db.query('UPDATE RunningInstances SET status=4 WHERE id IN (1,2)', {
      transaction,
    });
    assert.deepEqual(await read(transaction), []);
  });
  assert.deepEqual(await read(), []);
  assert.equal(
    (
      await db.query(
        'SELECT id FROM RunningInstances WHERE cron_id=2 AND status=0',
        { type: QueryTypes.SELECT },
      )
    )[0].id,
    10000,
  );
});
