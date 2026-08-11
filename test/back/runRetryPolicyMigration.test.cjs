require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  RUN_TABLE,
  runSchemaMigration,
} = require('../../back/migrations/0002-run-schema');
const {
  RUN_LOST_RETRY_INDEX,
  RUN_RETRY_POLICY_DUE_INDEX,
  RUN_RETRY_POLICY_TABLE,
  runRetryPolicyMigration,
} = require('../../back/migrations/0011-run-retry-policy');
const { runMigrations } = require('../../back/migrations/runner');

test('adds a compact, constrained Run retry policy table without rewriting Runs', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [runSchemaMigration, runRetryPolicyMigration],
    logger: { info() {} },
  });
  const queryInterface = database.getQueryInterface();
  const columns = await queryInterface.describeTable(RUN_RETRY_POLICY_TABLE);
  for (const column of [
    'run_id',
    'max_attempts',
    'retry_on_lost',
    'safety',
    'backoff_base_ms',
    'backoff_max_ms',
    'next_attempt_at_ms',
    'version',
    'created_at_ms',
    'updated_at_ms',
  ]) {
    assert.ok(columns[column], `missing ${RUN_RETRY_POLICY_TABLE}.${column}`);
  }
  const indexes = await queryInterface.showIndex(RUN_RETRY_POLICY_TABLE);
  assert.ok(indexes.some((index) => index.name === RUN_RETRY_POLICY_DUE_INDEX));
  const runIndexes = await queryInterface.showIndex(RUN_TABLE);
  assert.ok(runIndexes.some((index) => index.name === RUN_LOST_RETRY_INDEX));

  const runId = '019f7400-0000-7000-8000-000000000001';
  await queryInterface.bulkInsert(RUN_TABLE, [
    {
      id: runId,
      project_id: 'default',
      task_id: 'retry-test',
      task_revision: 'revision-1',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: 'runtime',
      status: 'lost',
      version: 0,
      event_sequence: 0,
      priority: 0,
      created_at_ms: 1_760_000_000_000,
    },
  ]);
  await queryInterface.bulkInsert(RUN_RETRY_POLICY_TABLE, [
    {
      run_id: runId,
      max_attempts: 3,
      retry_on_lost: true,
      safety: 'idempotent',
      backoff_base_ms: 100,
      backoff_max_ms: 1_000,
      version: 0,
      created_at_ms: 1_760_000_000_000,
      updated_at_ms: 1_760_000_000_000,
    },
  ]);
  await assert.rejects(
    queryInterface.bulkUpdate(
      RUN_RETRY_POLICY_TABLE,
      { max_attempts: 17 },
      { run_id: runId },
    ),
  );
});
