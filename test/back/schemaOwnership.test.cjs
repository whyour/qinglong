require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DataTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const { migrations } = require('../../back/migrations');
const {
  sqliteSchemaOwnership,
} = require('../../back/migrations/schemaOwnership');
const { runMigrations } = require('../../back/migrations/runner');

test('ownership manifest covers the registered SQLite migration chain', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  const queryInterface = database.getQueryInterface();

  for (const table of ['CrontabViews', 'Subscriptions', 'Crontabs', 'Envs']) {
    await queryInterface.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      unknown_legacy_column: { type: DataTypes.TEXT },
    });
  }
  for (const table of ['Apps', 'Auths', 'CrontabStats', 'Dependences']) {
    await queryInterface.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    });
  }
  await queryInterface.createTable('RunningInstances', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    started_at: { type: DataTypes.INTEGER, allowNull: false },
    unknown_runtime_column: { type: DataTypes.TEXT },
  });
  await queryInterface.createTable('UnknownHistoricalTable', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
  });

  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations,
    logger: { info() {} },
  });

  assert.deepEqual(
    sqliteSchemaOwnership.migrationIds,
    migrations.map((migration) => migration.id),
  );
  assert.equal(sqliteSchemaOwnership.unknownObjectPolicy, 'preserve-and-report');

  const tableNames = await queryInterface.showAllTables();
  for (const table of sqliteSchemaOwnership.tables) {
    assert.ok(tableNames.includes(table.name), `missing owned table ${table.name}`);
    const columns = await queryInterface.describeTable(table.name);
    for (const column of table.requiredColumns) {
      assert.ok(columns[column], `missing owned column ${table.name}.${column}`);
    }
  }

  const indexNames = new Set();
  for (const table of sqliteSchemaOwnership.tables) {
    if (!tableNames.includes(table.name)) continue;
    for (const index of await queryInterface.showIndex(table.name)) {
      indexNames.add(index.name);
    }
  }
  for (const index of sqliteSchemaOwnership.indexes) {
    assert.ok(indexNames.has(index.name), `missing owned index ${index.name}`);
  }

  assert.ok(tableNames.includes('UnknownHistoricalTable'));
  assert.ok(
    (await queryInterface.describeTable('Crontabs')).unknown_legacy_column,
  );
  assert.ok(
    (await queryInterface.describeTable('RunningInstances'))
      .unknown_runtime_column,
  );
});

test('ownership manifest has no duplicate table, column, index, or migration id', () => {
  const tableNames = sqliteSchemaOwnership.tables.map((table) => table.name);
  const indexNames = sqliteSchemaOwnership.indexes.map((index) => index.name);

  assert.equal(new Set(tableNames).size, tableNames.length);
  assert.equal(new Set(indexNames).size, indexNames.length);
  assert.equal(
    new Set(sqliteSchemaOwnership.migrationIds).size,
    sqliteSchemaOwnership.migrationIds.length,
  );
  for (const table of sqliteSchemaOwnership.tables) {
    assert.equal(
      new Set(table.requiredColumns).size,
      table.requiredColumns.length,
      `duplicate owned columns in ${table.name}`,
    );
  }
});
