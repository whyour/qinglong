const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Sequelize, QueryTypes } = require('sequelize');
const { migrateSchema } = require('../../back/shared/schemaMigrations');
const load = require('../helpers/load-security-module.cjs');

async function createLegacy(storage = ':memory:', omitEnvs = false) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
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
  assert.equal(applied.length, 15);
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
