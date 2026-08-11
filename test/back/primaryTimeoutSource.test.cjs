require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
  runSchemaMigration,
} = require('../../back/migrations/0002-run-schema');
const {
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizePrimaryTimeoutSource,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryTimeoutSource');

const databases = [];
const NOW = 1_750_300_000_000;
let sequence = 2000;

function nextId() {
  sequence += 1;
  return `019f7300-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

async function createRuntime() {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      runSchemaMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
    ],
    logger: { info() {} },
  });
  databases.push(database);
  return {
    database,
    source: new LegacySequelizePrimaryTimeoutSource(database),
  };
}

async function seed(database, overrides = {}) {
  const runId = overrides.runId ?? nextId();
  const attemptId = overrides.attemptId ?? nextId();
  await database.getQueryInterface().bulkInsert(RUN_TABLE, [
    {
      id: runId,
      project_id: 'default',
      task_id: 'timeout-task',
      task_revision: 'revision-1',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: overrides.executionOwner ?? 'runtime',
      status: overrides.runStatus ?? 'running',
      version: 3,
      event_sequence: 3,
      priority: 0,
      created_at_ms: NOW - 10_000,
      started_at_ms: NOW - 9_000,
      cancel_requested_at_ms: overrides.cancelRequestedAtMs ?? null,
    },
  ]);
  await database.getQueryInterface().bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: attemptId,
      run_id: runId,
      attempt: 1,
      status: overrides.attemptStatus ?? 'running',
      executor_type: 'local_process',
      callback_sequence: 0,
      created_at_ms: NOW - 10_000,
      started_at_ms: NOW - 9_000,
      deadline_at_ms:
        overrides.deadlineAtMs === undefined ? NOW - 1 : overrides.deadlineAtMs,
    },
  ]);
  return { runId, attemptId };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('lists only overdue active runtime-owned Attempts without cancellation', async () => {
  const { database, source } = await createRuntime();
  const due = await seed(database, { deadlineAtMs: NOW - 10 });
  await seed(database, { deadlineAtMs: NOW + 1 });
  await seed(database, { deadlineAtMs: null });
  await seed(database, { executionOwner: 'legacy' });
  await seed(database, { runStatus: 'succeeded' });
  await seed(database, { attemptStatus: 'claimed' });
  await seed(database, { cancelRequestedAtMs: NOW - 20 });

  assert.deepEqual(await source.listOverdue({ nowMs: NOW }), {
    candidates: [
      {
        runId: due.runId,
        attemptId: due.attemptId,
        deadlineAtMs: NOW - 10,
      },
    ],
    truncated: false,
  });
});

test('paginates equal deadlines by Attempt id with a stable bounded cursor', async () => {
  const { database, source } = await createRuntime();
  const first = await seed(database, { deadlineAtMs: NOW - 5 });
  const second = await seed(database, { deadlineAtMs: NOW - 5 });

  const page1 = await source.listOverdue({ nowMs: NOW, limit: 1 });
  assert.equal(page1.truncated, true);
  assert.deepEqual(
    page1.candidates.map((item) => item.attemptId),
    [first.attemptId],
  );
  assert.deepEqual(page1.nextCursor, {
    deadlineAtMs: NOW - 5,
    attemptId: first.attemptId,
  });

  const page2 = await source.listOverdue({
    nowMs: NOW,
    limit: 1,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.truncated, false);
  assert.deepEqual(
    page2.candidates.map((item) => item.attemptId),
    [second.attemptId],
  );
});

test('rejects unbounded timeout scans and malformed cursors', async () => {
  const { source } = await createRuntime();
  await assert.rejects(source.listOverdue({ nowMs: -1 }), /nowMs/);
  await assert.rejects(source.listOverdue({ nowMs: NOW, limit: 65 }), /limit/);
  await assert.rejects(
    source.listOverdue({
      nowMs: NOW,
      cursor: { deadlineAtMs: -1, attemptId: 'attempt' },
    }),
    /deadlineAtMs/,
  );
  await assert.rejects(
    source.listOverdue({
      nowMs: NOW,
      cursor: { deadlineAtMs: NOW, attemptId: '' },
    }),
    /attemptId/,
  );
});
