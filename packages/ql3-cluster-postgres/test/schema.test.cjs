require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getTableConfig } = require('drizzle-orm/pg-core');
const {
  postgresqlControlSchemaContract,
  ql3PostgresTables,
} = require('../dist');

function describeTable(table) {
  const config = getTableConfig(table);
  const primaryIndexes = config.columns
    .filter((column) => column.primary)
    .map(() => `${config.name}_pkey`);
  return {
    name: config.name,
    schema: config.schema,
    columns: config.columns.map((column) => column.name),
    indexes: [
      ...primaryIndexes,
      ...config.primaryKeys.map((entry) => entry.getName()),
      ...config.indexes.map((entry) => entry.config.name),
    ],
    checks: config.checks.map((entry) => entry.name),
    foreignKeys: config.foreignKeys.map((entry) => entry.getName()),
  };
}

test('Drizzle schema exactly matches the reviewed ql3 table and index contract', () => {
  const drizzleTables = ql3PostgresTables.map(describeTable);
  assert.deepEqual(
    drizzleTables.map(({ name, schema, columns }) => ({
      name,
      schema,
      columns,
    })),
    postgresqlControlSchemaContract.tables.map(({ name, columns }) => ({
      name,
      schema: postgresqlControlSchemaContract.schema,
      columns: [...columns],
    })),
  );
  assert.deepEqual(
    drizzleTables.flatMap(({ indexes }) => indexes).sort(),
    [...postgresqlControlSchemaContract.indexes].sort(),
  );
});

test('Drizzle schema carries every named ql3 check and foreign-key boundary', () => {
  const drizzleTables = ql3PostgresTables.map(describeTable);
  const checks = drizzleTables.flatMap((table) => table.checks).sort();
  const foreignKeys = drizzleTables
    .flatMap((table) => table.foreignKeys)
    .sort();
  assert.deepEqual(checks, [...postgresqlControlSchemaContract.checks].sort());
  assert.deepEqual(
    foreignKeys,
    [...postgresqlControlSchemaContract.foreignKeys].sort(),
  );
  assert.equal(
    drizzleTables.some(({ name }) =>
      ['crontabs', 'envs', 'subscriptions', 'runninginstances'].includes(name),
    ),
    false,
  );
});
