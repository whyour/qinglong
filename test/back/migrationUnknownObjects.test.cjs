require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { DataTypes, QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  legacyColumnsMigration,
} = require('../../back/migrations/0001-legacy-columns');
const { runMigrations } = require('../../back/migrations/runner');

const databases = [];

async function createDatabase() {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const migrationModel = defineSchemaMigrationModel(database);
  databases.push(database);
  return { database, migrationModel };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('preserves unknown tables, columns, indexes, and rows during legacy migration', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();

  for (const table of ['CrontabViews', 'Subscriptions', 'Envs']) {
    await queryInterface.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    });
  }
  await queryInterface.createTable('Crontabs', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    external_note: { type: DataTypes.STRING },
  });
  await queryInterface.addIndex('Crontabs', ['external_note'], {
    name: 'external_crontab_note_index',
  });
  await queryInterface.createTable('ExternalPluginState', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    payload: { type: DataTypes.TEXT, allowNull: false },
  });
  await queryInterface.bulkInsert('Crontabs', [
    { id: 1, external_note: 'preserve-me' },
  ]);
  await queryInterface.bulkInsert('ExternalPluginState', [
    { id: 1, payload: '{"source":"fixture"}' },
  ]);

  const options = {
    database,
    migrationModel,
    migrations: [legacyColumnsMigration],
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const tables = await queryInterface.showAllTables();
  const crontabs = await queryInterface.describeTable('Crontabs');
  const indexes = await queryInterface.showIndex('Crontabs');
  const cronRows = await database.query(
    'SELECT id, external_note FROM Crontabs ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  const pluginRows = await database.query(
    'SELECT id, payload FROM ExternalPluginState ORDER BY id',
    { type: QueryTypes.SELECT },
  );

  assert.ok(tables.includes('ExternalPluginState'));
  assert.ok(crontabs.external_note);
  assert.ok(indexes.some((index) => index.name === 'external_crontab_note_index'));
  assert.deepEqual(cronRows, [{ id: 1, external_note: 'preserve-me' }]);
  assert.deepEqual(pluginRows, [{ id: 1, payload: '{"source":"fixture"}' }]);
  assert.equal(await migrationModel.count(), 1);
});
