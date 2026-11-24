const assert = require('node:assert/strict');
const test = require('node:test');
const { Sequelize, QueryTypes } = require('sequelize');
const { QueueOccupants } = require('../../back/cron/queries/queueDiagnostics');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise(setImmediate);
function gate() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail('diagnostic sample was not published');
}
async function fixture(t) {
  const db = new Sequelize('sqlite::memory:', { logging: false });
  await db.query(
    "CREATE TABLE CronTriggers(id TEXT PRIMARY KEY, state TEXT DEFAULT 'queued', queued_at INTEGER, dequeued_at INTEGER, queue_context TEXT, queue_live_context TEXT)",
  );
  await db.query('CREATE TABLE Changes(id TEXT)');
  await db.query(
    'CREATE TRIGGER count_live_updates AFTER UPDATE OF queue_live_context ON CronTriggers BEGIN INSERT INTO Changes VALUES(NEW.id); END',
  );
  const warnings = [];
  let liveWrites = 0;
  db.options.logging = (sql) => {
    if (
      sql
        .replace(/[`"]/g, '')
        .includes('UPDATE CronTriggers SET queue_live_context=')
    )
      liveWrites++;
  };
  const pool = new QueueOccupants(
    'scheduled',
    () => 1,
    (error) => warnings.push(error),
  );
  const ids = new Set();
  t.after(async () => {
    for (const id of ids) pool.forget(id);
    await sleep(20);
    await db.close();
  });
  return {
    db,
    pool,
    warnings,
    liveWrites: () => liveWrites,
    async add(id, fields = '') {
      await db.query('INSERT INTO CronTriggers(id,queued_at) VALUES ($id,1)', {
        bind: { id },
      });
      if (fields)
        await db.query('UPDATE CronTriggers SET ' + fields + ' WHERE id=$id', {
          bind: { id },
        });
      ids.add(id);
      pool.watch(id, db);
    },
    async rows(sql = 'SELECT * FROM CronTriggers ORDER BY id') {
      return db.query(sql, { type: QueryTypes.SELECT });
    },
  };
}

test('asynchronous admissions share one sample and unchanged holders are not rewritten', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    await f.add('wait-' + i);
    await tick();
  }
  await until(() => f.liveWrites() >= 1);
  await until(
    async () => (await f.rows('SELECT * FROM Changes')).length === 30,
  );
  assert.equal(f.liveWrites(), 1);
  for (let i = 0; i < 20; i++) {
    f.pool.refresh();
    await tick();
  }
  await sleep(300);
  assert.equal(f.liveWrites(), 1);
  await f.add('new-wait');
  await until(() => f.liveWrites() === 2);
  await until(
    async () => (await f.rows('SELECT * FROM Changes')).length === 31,
  );
  assert.equal(
    (await f.rows()).every(
      (row) => row.state === 'queued' && row.dequeued_at === null,
    ),
    true,
  );
  assert.deepEqual(f.warnings, []);
});

test('dispatch and cancellation clear pending samples, and sampling never overwrites dispatched or terminal rows', async (t) => {
  const f = await fixture(t);
  await f.add('cancelled');
  f.pool.forget('cancelled');
  await sleep(300);
  assert.equal(f.liveWrites(), 0);
  await f.add('running', "state='running'");
  await f.add('dequeued', 'dequeued_at=2');
  await f.add('stopped', "state='stopped'");
  await f.add('waiting');
  await until(async () => (await f.rows('SELECT * FROM Changes')).length > 0);
  const changed = await f.rows('SELECT * FROM Changes');
  assert.deepEqual(
    changed.map((x) => x.id),
    ['waiting'],
  );
  let ran = false;
  await f.pool.track(
    async () => {
      ran = true;
    },
    { id: 'waiting', name: 'task' },
    f.db,
  )();
  assert.equal(ran, true);
  await until(
    async () =>
      (
        await f.rows("SELECT * FROM CronTriggers WHERE id='waiting'")
      )[0].dequeued_at !== null,
  );
  const [row] = await f.rows("SELECT * FROM CronTriggers WHERE id='waiting'");
  assert.equal(row.queue_live_context, null);
  await sleep(300);
  const [later] = await f.rows("SELECT * FROM CronTriggers WHERE id='waiting'");
  assert.equal(later.queue_live_context, null);
  assert.equal(later.dequeued_at, row.dequeued_at);
});

test('a slow sample is serialized while execution continues and newer observations are eventually published', async (t) => {
  const pause = gate();
  let inFlight = 0,
    peak = 0,
    calls = 0,
    context;
  const model = {
    async update(values) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      calls++;
      if (calls === 1) await pause.promise;
      context = JSON.parse(values.queue_live_context);
      inFlight--;
    },
  };
  const db = { isDefined: () => true, model: () => model };
  let limit = 1;
  const pool = new QueueOccupants('manual', () => limit, assert.fail);
  pool.watch('waiting', db);
  await until(() => calls === 1);
  const active = gate();
  const work = pool.track(() => active.promise, { name: 'holder' })();
  limit = 2;
  for (let i = 0; i < 10; i++) pool.refresh();
  await sleep(300);
  assert.equal(calls, 1);
  let fastRan = false;
  await pool.track(
    async () => {
      fastRan = true;
    },
    { name: 'fast' },
  )();
  assert.equal(fastRan, true);
  pause.release();
  await until(() => calls === 2 && inFlight === 0);
  assert.equal(peak, 1);
  assert.equal(context.limit, 2);
  assert.deepEqual(context.holders, [{ name: 'holder' }]);
  pool.forget('waiting');
  active.release();
  await work;
});

test('failed samples do not fail executions and can be retried after another refresh', async () => {
  const warnings = [];
  let fail = true,
    calls = 0;
  const model = {
    async update() {
      calls++;
      if (fail) throw Error('busy');
    },
  };
  const db = { isDefined: () => true, model: () => model };
  const pool = new QueueOccupants(
    'manual',
    () => 1,
    (error) => warnings.push(error.message),
  );
  pool.watch('waiting', db);
  await until(() => warnings.length === 1);
  assert.equal(await pool.track(async () => 42, { name: 'work' })(), 42);
  fail = false;
  pool.refresh();
  await until(() => calls === 2);
  await sleep(20);
  pool.refresh();
  await sleep(300);
  assert.equal(calls, 2);
  assert.deepEqual(warnings, ['busy']);
  pool.forget('waiting');
});

test('removing and re-admitting an ID during an in-flight sample cannot mark the new wait as sampled', async () => {
  const pause = gate();
  let calls = 0;
  const model = {
    async update() {
      calls++;
      if (calls === 1) await pause.promise;
    },
  };
  const db = { isDefined: () => true, model: () => model };
  const pool = new QueueOccupants('scheduled', () => 1, assert.fail);
  pool.watch('same-id', db);
  await until(() => calls === 1);
  pool.forget('same-id');
  pool.watch('same-id', db);
  pause.release();
  await until(() => calls === 2);
  pool.forget('same-id');
});
