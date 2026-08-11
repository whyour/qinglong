require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  SequelizeSqliteMigrationStreamStore,
} = require('../../back/migrations/adapters/sequelizeSqliteMigrationStreamStore');
const { runMigrations } = require('../../back/migrations/runner');
const {
  MigrationStreamAheadOfCodeError,
} = require('../../back/migrations/core/migrationStream');

test('runner preserves legacy history rows and log format through the stream store', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  const migrationModel = defineSchemaMigrationModel(database);
  const logs = [];
  await runMigrations({
    database,
    migrationModel,
    migrations: [
      {
        id: '0001-compatibility',
        checksum: 'checksum-v1',
        async up() {},
      },
    ],
    logger: {
      info(message) {
        logs.push(message);
      },
    },
  });
  const applied = (await migrationModel.findByPk('0001-compatibility')).get({
    plain: true,
  });
  assert.deepEqual(Object.keys(applied).sort(), [
    'applied_at',
    'checksum',
    'id',
  ]);
  assert.equal(applied.id, '0001-compatibility');
  assert.equal(applied.checksum, 'checksum-v1');
  assert.ok(Number.isSafeInteger(Number(applied.applied_at)));
  assert.deepEqual(logs, ['[migration] Applied 0001-compatibility']);
});

test('SQLite stream store rejects a non-SQLite topology before history access', () => {
  const migrationModel = {
    sync() {
      throw new Error('unreachable');
    },
  };
  assert.throws(
    () =>
      new SequelizeSqliteMigrationStreamStore(
        {
          getDialect() {
            return 'postgres';
          },
        },
        migrationModel,
      ),
    /requires SQLite/,
  );
});

test('default SQLite runner rejects history written by newer code', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  const migrationModel = defineSchemaMigrationModel(database);
  await migrationModel.sync();
  await migrationModel.create({
    id: '9999-future-schema',
    checksum: 'future-checksum',
    applied_at: 1,
  });
  await assert.rejects(
    runMigrations({ database, migrationModel }),
    MigrationStreamAheadOfCodeError,
  );
});
