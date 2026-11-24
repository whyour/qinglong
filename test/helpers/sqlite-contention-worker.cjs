const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const load = require('./load-security-module.cjs');
const [root, mode] = process.argv.slice(2);
const { sequelize: db } = load('back/data/index.ts', {
  '../config/index': { dbPath: root },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await db.query('CREATE TABLE results (id INTEGER PRIMARY KEY)');
  const owner = await db.transaction();
  await db.query('INSERT INTO results VALUES (0)', { transaction: owner });
  let callbacks = 0;
  const contenders = Promise.all(
    Array.from({ length: 32 }, (_, i) =>
      db.transaction(async (transaction) => {
        callbacks++;
        await db.query('INSERT INTO results VALUES ($id)', {
          transaction,
          bind: { id: i + 1 },
        });
        // File work shares libuv's pool with SQLite. Waiting writers must not
        // prevent either this work or the current writer's COMMIT from running.
        await fs.readFile(__filename);
        await delay(2);
      }),
    ),
  );
  // Observe early rejections without letting the process exit before cleanup.
  contenders.catch(() => {});
  await delay(30);
  const read = fs.readFile(__filename);
  assert.equal(
    await Promise.race([
      read.then(() => 'read'),
      delay(1000).then(() => 'blocked'),
    ]),
    'read',
    'waiting SQLite writers exhausted the shared worker pool',
  );
  if (mode === 'rollback') {
    // Longer than the old JS-only retry budget: retain tolerance for a real
    // writer, without sleeping in the native worker pool.
    await delay(2000);
    await owner.rollback();
  } else {
    await owner.commit();
  }
  await contenders;
  const [rows] = await db.query('SELECT id FROM results ORDER BY id');
  assert.deepEqual(
    rows.map((row) => row.id),
    Array.from({ length: mode === 'rollback' ? 32 : 33 }, (_, i) =>
      mode === 'rollback' ? i + 1 : i,
    ),
  );
  assert.equal(callbacks, 32, 'transaction callbacks must not be replayed');
  const [[durability]] = await db.query('PRAGMA synchronous');
  assert.equal(durability.synchronous, 3);
  await assert.rejects(
    db.transaction(async (transaction) => {
      await db.query('INSERT INTO results VALUES (99)', { transaction });
      await db.query('INSERT INTO results VALUES (1)', { transaction });
    }),
    /Validation error/,
  );
  const [rolledBack] = await db.query('SELECT id FROM results WHERE id=99');
  assert.deepEqual(rolledBack, []);
  await db.close();
  console.log(JSON.stringify({ callbacks, rows: rows.length, mode }));
})().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
