const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Sequelize, DataTypes, QueryTypes, Transaction } = require('sequelize');
const { migrateSchema } = require('../../back/shared/schemaMigrations');
const load = require('../helpers/load-security-module.cjs');

async function createLegacy(storage = ':memory:', omitEnvs = false) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
  });
  for (const table of [
    'CrontabViews',
    'Subscriptions',
    'Crontabs',
    ...(omitEnvs ? [] : ['Envs']),
  ]) {
    await database.query(
      `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, name TEXT)`,
    );
  }
  await database.query(
    'INSERT INTO "Crontabs" (id, name) VALUES (1, \'keep-me\')',
  );
  await database.query('ALTER TABLE Crontabs ADD COLUMN last_execution_time INTEGER');
  await database.query('ALTER TABLE Crontabs ADD COLUMN last_running_time INTEGER');
  load('back/data/runningInstance.ts', { '.': { sequelize: database } });
  load('back/data/cronStats.ts', { '.': { sequelize: database } });
  await database.sync();
  return database;
}

test('legacy database upgrades without losing rows and repeated migration is idempotent', async (t) => {
  const database = await createLegacy();
  t.after(() => database.close());
  await migrateSchema(database);
  await migrateSchema(database);
  const rows = await database.query('SELECT * FROM "Crontabs"', {
    type: QueryTypes.SELECT,
  });
  assert.equal(rows[0].name, 'keep-me');
  assert.equal(rows[0].queued_token, null);
  assert.ok(Object.hasOwn(rows[0], 'allow_multiple_instances'));
  const applied = await database.query('SELECT id FROM "SchemaMigrations"', {
    type: QueryTypes.SELECT,
  });
  assert.equal(applied.length, 27);
  assert.ok(Object.hasOwn(await database.getQueryInterface().describeTable('CrontabStats'), 'fixed_max_time'));
  assert.equal(rows[0].last_instance_id, null);
  assert.equal(rows[0].catchup_seconds, null);
  assert.equal(rows[0].max_queue_wait, null);
});

test('migration repairs malformed environment labels before ORM reads', async (t) => {
  const database = await createLegacy();
  t.after(() => database.close());
  await migrateSchema(database);
  for (const [id, labels] of [
    [1, ''],
    [2, null],
    [3, '{invalid'],
    [4, '{}'],
    [5, '["keep"]'],
  ]) {
    await database.query('INSERT INTO "Envs" (id, name, labels) VALUES (?, ?, ?)', {
      replacements: [id, `env-${id}`, labels],
    });
  }

  const EnvModel = database.define('Env', {
    name: DataTypes.STRING,
    labels: DataTypes.JSON,
  }, { timestamps: false });
  await assert.rejects(EnvModel.findAll(), /Unexpected end of JSON input/);
  await migrateSchema(database);
  const rows = await EnvModel.findAll({ order: [['id', 'ASC']] });
  assert.deepEqual(rows.map((row) => row.labels), [[], [], [], [], ['keep']]);
  await migrateSchema(database);
  const repaired = await database.query('SELECT id, labels FROM "Envs" ORDER BY id', {
    type: QueryTypes.SELECT,
  });
  assert.deepEqual(repaired.map(({ labels }) => labels), [
    '[]', '[]', '[]', '[]', '["keep"]',
  ]);
});

test('migration failure rolls back added columns and can be retried after repair', async (t) => {
  const database = await createLegacy(':memory:', true);
  t.after(() => database.close());
  await assert.rejects(migrateSchema(database));
  const columns = await database.getQueryInterface().describeTable('Crontabs');
  assert.equal(Object.hasOwn(columns, 'work_dir'), false);
  await database.query(
    'CREATE TABLE "Envs" (id INTEGER PRIMARY KEY, name TEXT)',
  );
  await migrateSchema(database);
  assert.ok(
    Object.hasOwn(
      await database.getQueryInterface().describeTable('Crontabs'),
      'work_dir',
    ),
  );
});

test('offline pre-upgrade backup restores the legacy schema and data', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'database.sqlite');
  const backup = path.join(dir, 'before.sqlite');
  let database = await createLegacy(file);
  await database.close();
  await fs.copyFile(file, backup);
  database = new Sequelize({
    dialect: 'sqlite',
    storage: file,
    logging: false,
  });
  await migrateSchema(database);
  await database.close();
  await fs.copyFile(backup, file);
  database = new Sequelize({
    dialect: 'sqlite',
    storage: file,
    logging: false,
  });
  try {
    assert.equal(
      Object.hasOwn(
        await database.getQueryInterface().describeTable('Crontabs'),
        'work_dir',
      ),
      false,
    );
    const rows = await database.query('SELECT name FROM "Crontabs"', {
      type: QueryTypes.SELECT,
    });
    assert.equal(rows[0].name, 'keep-me');
  } finally {
    await database.close();
  }
});

test('database loader rejects initialization failure rather than allowing workers to start', async () => {
  const mocks = { './logger': { error() {}, info() {} } };
  for (const [file, model] of [
    ['env', 'EnvModel'],
    ['cron', 'CrontabModel'],
    ['dependence', 'DependenceModel'],
    ['open', 'AppModel'],
    ['system', 'SystemModel'],
    ['subscription', 'SubscriptionModel'],
    ['cronView', 'CrontabViewModel'],
    ['cronStats', 'CrontabStatModel'],
    ['runningInstance', 'RunningInstanceModel'],
  ])
    mocks[`../data/${file}`] = { [model]: { sync: async () => {} } };
  mocks['../data'] = { sequelize: {} };
  mocks['../shared/schemaMigrations'] = {
    migrateSchema: async () => {
      throw new Error('SQLITE_FULL');
    },
  };
  const initialize = load(path.resolve('back/loaders/db.ts'), mocks).default;
  await assert.rejects(initialize(), /SQLITE_FULL/);
});

test('upgrading stop batches preserves completed and pending idempotency bindings', async t => {
  const database = await createLegacy();
  t.after(() => database.close());
  await database.query('CREATE TABLE CronStopBatches (request_id TEXT PRIMARY KEY,cron_ids TEXT NOT NULL,snapshot TEXT)');
  await database.query("INSERT INTO CronStopBatches VALUES ('done','[1]',NULL),('retry','[2]','{}')");
  await migrateSchema(database);
  await migrateSchema(database);
  const rows = await database.query('SELECT request_id,cron_ids,snapshot,status_code FROM CronStopBatches ORDER BY request_id',
    { type: QueryTypes.SELECT });
  assert.deepEqual(rows, [
    { request_id: 'done', cron_ids: '[1]', snapshot: null, status_code: 200 },
    { request_id: 'retry', cron_ids: '[2]', snapshot: '{}', status_code: 200 },
  ]);
});

test('upgrade preserves an already pruned bound booking when its canonical file was reclaimed before restart', async t => {
  const database = await createLegacy();
  t.after(() => database.close());
  await migrateSchema(database);
  // Previous panel committed both bookings, then removed the files. An
  // unbound result by itself cannot authenticate a later versioned receipt.
  await database.query("DELETE FROM SchemaMigrations WHERE id='preserve-pruned-bound-exits-v1'");
  await database.query(`INSERT INTO CronLegacyExitBookings(trigger_id,cron_id,source,started_at,finished_at,outcome,day,bound)
    VALUES ('bound-before-upgrade',1,'manual',1000,2000,'31','1970-01-01',1),
           ('legacy-before-upgrade',1,'manual',1000,2000,'0','1970-01-01',0)`);
  await migrateSchema(database);
  await database.query('DELETE FROM CronLegacyExitBookings');
  await migrateSchema(database);
  assert.deepEqual(await database.query('SELECT trigger_id,outcome,finished_at FROM CronUnmatchedBoundExits',
    { type: QueryTypes.SELECT }), [{trigger_id:'bound-before-upgrade', outcome:'31', finished_at:2000}]);
  assert.deepEqual(await database.query('SELECT * FROM CrontabStats', { type: QueryTypes.SELECT }), []);
});

for (const committed of [false, true]) {
  test('pruned booking evidence and its marker survive cleanup after migration ' +
    (committed ? 'commit' : 'rollback'), async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-migration-cut-'));
    const previousDataDir = process.env.QL_DATA_DIR;
    process.env.QL_DATA_DIR = directory;
    await fs.mkdir(path.join(directory, 'db'));
    await fs.writeFile(path.join(directory, '.env'), '');
    const db = await createLegacy(path.join(directory, 'db/database.sqlite'));
    t.after(async () => {
      if (previousDataDir === undefined) delete process.env.QL_DATA_DIR;
      else process.env.QL_DATA_DIR = previousDataDir;
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await migrateSchema(db);
    const marker = 'preserve-pruned-bound-exits-v1', id = 'old-bound';
    const select = sql => db.query(sql, { type: QueryTypes.SELECT });
    const late = Date.now();
    const retainedDay = require('dayjs')(late).format('YYYY-MM-DD');
    const stats = db.models.CrontabStat;
    const expired = await stats.create({ ref_id: 1, date: '1970-01-01', run_count: 1, fail_count: 1, total_time: 1000, max_time: 1000 });
    await stats.create({ ref_id: 1, date: retainedDay, run_count: 1, success_count: 1, total_time: 333, max_time: 333 });
    const daily = () => select('SELECT date,run_count,success_count,fail_count,total_time,max_time FROM CrontabStats ORDER BY date');
    const sibling = { date: retainedDay, run_count: 1, success_count: 1, fail_count: 0, total_time: 333, max_time: 333 };
    await db.query('DELETE FROM SchemaMigrations WHERE id=$marker', { bind: { marker } });
    await db.query(`INSERT INTO CronLegacyExitBookings(trigger_id,cron_id,source,started_at,finished_at,outcome,day,bound,stat_id)
      VALUES ($id,1,'manual',1000,2000,'31','1970-01-01',1,$stat)`, { bind: { id, stat: expired.id } });
    const side = committed ? 'after' : 'before';
    const gate = path.join(directory, 'checkpoint');
    const worker = require('node:child_process').spawn(process.execPath, [
      '-r', 'ts-node/register/transpile-only', require.resolve('../helpers/receipt-migration-worker.cjs'),
      path.resolve(__dirname, '../../back'), side, gate,
    ], { env: { ...process.env, QL_DIR: directory }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';
    worker.stderr.on('data', data => { errorOutput += data; });
    const closed = require('node:events').once(worker, 'close');
    try {
      const deadline = Date.now() + 30000;
      while (!require('node:fs').existsSync(gate)) {
        assert.ok(worker.exitCode === null && worker.signalCode === null && Date.now() < deadline,
          'Migration worker failed to reach COMMIT boundary: ' + errorOutput);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const checkpoint = JSON.parse(await fs.readFile(gate, 'utf8'));
      assert.deepEqual(checkpoint, { side, pid: worker.pid, marker: 1, proofs: 1 });
      // Observe from the parent's independent connection while the writer is still frozen.
      assert.equal((await select('SELECT trigger_id FROM CronUnmatchedBoundExits')).length, Number(committed));
    } finally {
      worker.kill('SIGKILL');
      await closed;
    }
    const proof = () => select('SELECT trigger_id,outcome,finished_at FROM CronUnmatchedBoundExits');
    const expected = [{trigger_id:id, outcome:'31', finished_at:2000}];
    assert.deepEqual(await proof(), committed ? expected : []);
    assert.equal((await select("SELECT id FROM SchemaMigrations WHERE id='preserve-pruned-bound-exits-v1'")).length, +committed);

    const policy = new (load('back/services/retention.ts', {
      '../data': { sequelize: db }, '../data/cronStats': { CrontabStatModel: db.models.CrontabStat },
      '../data/runningInstance': { RunningInstanceModel: db.models.RunningInstance, InstanceStatus: { running: 0 } },
      '../data/system': {}, '../config': {},
    }).default)();
    const clean = () => policy.cleanup({ runningInstanceRetentionDays: 0, cronStatRetentionDays: 1 });
    await clean(); // This writer acquires the lock before the migration retry.
    assert.deepEqual(await daily(), [sibling]);
    assert.deepEqual(await select('SELECT trigger_id FROM CronLegacyExitBookings'), committed ? [] : [{trigger_id:id}]);
    await migrateSchema(db);
    await clean();
    await migrateSchema(db);
    assert.deepEqual(await proof(), expected);
    assert.deepEqual(await select('SELECT trigger_id FROM CronLegacyExitBookings'), []);
    const { writeExit } = require('../../back/shared/managedExit.cjs');
    const { TriggerHistory } = require('../../back/shared/triggerHistory');
    const history = new TriggerHistory(db);
    writeExit(id, 0, null, late);
    await history.retryPendingExits();
    writeExit(id, 31, null, 2000);
    await Promise.all([clean(), history.retryPendingExits()]);
    await history.interrupt('http');
    assert.deepEqual(await select('SELECT outcome,finished_at FROM CronBoundExitConflicts ORDER BY finished_at'),
      [{outcome: '31', finished_at: 2000}, {outcome: '0', finished_at: late}]);
    assert.deepEqual(await daily(), [sibling]);
    assert.deepEqual(await select('SELECT id FROM CronTriggers'), []);
  });
}
