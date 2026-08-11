require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  auditSqliteSchema,
} = require('../../back/migrations/schemaAudit');

const manifest = {
  version: 1,
  database: 'database.sqlite',
  migrationIds: ['0001', '0002'],
  tables: [
    {
      name: 'Owned',
      mode: 'full',
      requiredColumns: ['id', 'value'],
    },
    {
      name: 'Legacy',
      mode: 'extension',
      requiredColumns: ['ql3_ref'],
    },
    {
      name: 'OptionalLegacy',
      mode: 'unmanaged-legacy',
      requiredColumns: [],
    },
  ],
  indexes: [{ name: 'owned_value_idx' }],
  constraints: [],
  unknownObjectPolicy: 'preserve-and-report',
};

test('schema audit accepts the owned contract while reporting preserved drift', () => {
  const report = auditSqliteSchema(
    {
      migrationIds: ['0001', '0002', 'future-external'],
      tables: [
        {
          name: 'Owned',
          columns: ['id', 'value', 'future_column'],
          indexes: ['owned_value_idx', 'future_index'],
        },
        {
          name: 'Legacy',
          columns: ['id', 'legacy_value', 'ql3_ref'],
          indexes: ['legacy_unmanaged_idx'],
        },
        {
          name: 'Historical',
          columns: ['id'],
          indexes: ['historical_unknown_idx'],
        },
      ],
    },
    manifest,
  );

  assert.equal(report.compatible, true);
  assert.equal(report.driftDetected, true);
  assert.deepEqual(report.unknownTables, ['Historical']);
  assert.deepEqual(report.unknownColumns, [
    { table: 'Owned', column: 'future_column' },
  ]);
  assert.deepEqual(report.unknownIndexes, [
    'future_index',
    'historical_unknown_idx',
  ]);
  assert.deepEqual(report.extraMigrationIds, ['future-external']);
});

test('schema audit rejects missing owned structures and migration history', () => {
  const report = auditSqliteSchema(
    {
      migrationIds: ['0001'],
      tables: [
        { name: 'Owned', columns: ['id'], indexes: [] },
      ],
    },
    manifest,
  );

  assert.equal(report.compatible, false);
  assert.deepEqual(report.missingTables, ['Legacy']);
  assert.deepEqual(report.missingColumns, [
    { table: 'Owned', column: 'value' },
  ]);
  assert.deepEqual(report.missingIndexes, ['owned_value_idx']);
  assert.deepEqual(report.missingMigrationIds, ['0002']);
});

test('schema audit ignores unmanaged columns on extension tables', () => {
  const report = auditSqliteSchema(
    {
      migrationIds: ['0001', '0002'],
      tables: [
        {
          name: 'Owned',
          columns: ['id', 'value'],
          indexes: ['owned_value_idx'],
        },
        {
          name: 'Legacy',
          columns: ['id', 'legacy_value', 'ql3_ref'],
          indexes: [],
        },
      ],
    },
    manifest,
  );

  assert.equal(report.compatible, true);
  assert.equal(report.driftDetected, false);
  assert.deepEqual(report.unknownColumns, []);
});
