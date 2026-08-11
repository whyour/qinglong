require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DataTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const { migrations } = require('../../back/migrations');
const {
  createDefaultManualPrimaryActivationStack,
} = require('../../back/runtime/adapters/legacy/defaultManualPrimaryActivation');
const {
  RuntimeRolloutPolicy,
} = require('../../back/runtime/domain/runtimeRollout');
const { runMigrations } = require('../../back/migrations/runner');

async function createDatabase(t) {
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
    });
  }
  await queryInterface.createTable('RunningInstances', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    started_at: { type: DataTypes.INTEGER, allowNull: false },
  });
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations,
    logger: { info() {} },
  });
  return database;
}

test('real Primary activation stack reconciles empty state and stops cleanly', async (t) => {
  const database = await createDatabase(t);
  const rollout = new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: { manual: 'primary' },
    allowLegacyFallbackBeforeStart: false,
  });
  const stack = createDefaultManualPrimaryActivationStack(rollout, {
    database,
    owner: 'test-http-worker',
    recovery: { pageSize: 8, maxPages: 2 },
    cancellation: {
      intervalMs: 1_000,
      initialDelayMs: 60_000,
      stopTimeoutMs: 1_000,
      cycle: { pageSize: 8, maxPages: 2 },
    },
    timeout: {
      intervalMs: 5_000,
      initialDelayMs: 60_000,
      stopTimeoutMs: 1_000,
      cycle: { pageSize: 8, maxPages: 2 },
    },
  });

  assert.deepEqual(await stack.reconcile(), {
    pages: 1,
    scanned: 0,
    verifiedRunning: 0,
    recoveredRunning: 0,
    completedFromReceipt: 0,
    quarantinedReceipts: 0,
    publishGraceWaits: 0,
    markedLost: 0,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
  });
  assert.equal(stack.startCompletion(), true);
  assert.equal(stack.startCompletion(), false);
  assert.equal(stack.startTimeout(), true);
  assert.equal(stack.startTimeout(), false);
  assert.equal(stack.startCancellation(), true);
  assert.equal(stack.startCancellation(), false);
  assert.equal(await stack.stopTimeout(), 'drained');
  assert.equal(await stack.stopCancellation(), 'drained');
  assert.equal(await stack.stopCompletion(), 'drained');
});

test('real Primary activation stack rejects invalid worker ownership', async (t) => {
  const database = await createDatabase(t);
  const rollout = new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: { manual: 'primary' },
    allowLegacyFallbackBeforeStart: false,
  });

  assert.throws(
    () =>
      createDefaultManualPrimaryActivationStack(rollout, {
        database,
        owner: '',
      }),
    RangeError,
  );
});

test('local SQLite Primary stack refuses cluster-control and worker profiles', async (t) => {
  const database = await createDatabase(t);
  const rollout = new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: { manual: 'primary' },
    allowLegacyFallbackBeforeStart: false,
  });

  for (const deploymentProfile of ['cluster-control', 'worker']) {
    assert.throws(
      () =>
        createDefaultManualPrimaryActivationStack(rollout, {
          database,
          deploymentProfile,
        }),
      /cannot host the local SQLite Primary stack/,
    );
  }
});
