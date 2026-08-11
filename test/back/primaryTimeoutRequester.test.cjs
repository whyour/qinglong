require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const { runSchemaMigration } = require('../../back/migrations/0002-run-schema');
const {
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  LegacySequelizePrimaryTimeoutSource,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryTimeoutSource');
const {
  PrimaryTimeoutRequester,
} = require('../../back/runtime/application/primaryTimeoutRequester');
const {
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');

const NOW = 1_750_300_000_000;
const databases = [];

function page(candidates, overrides = {}) {
  return { candidates, truncated: false, ...overrides };
}

function candidate(index, overrides = {}) {
  return {
    runId: `run-${index}`,
    attemptId: `attempt-${index}`,
    deadlineAtMs: NOW - index,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('commits a durable timeout request through the real Repository boundary', async () => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  databases.push(database);
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
  const repository = new LegacySequelizeRunRepository(database);
  const runId = '019f7300-0000-7000-8000-000000000101';
  const attemptId = '019f7300-0000-7000-8000-000000000102';
  await repository.transaction(async (transaction) => {
    await transaction.insertRun({
      id: runId,
      projectId: 'default',
      taskId: 'timeout-task',
      taskRevision: 'revision-1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      status: 'running',
      version: 3,
      eventSequence: 3,
      priority: 0,
      createdAtMs: NOW - 10_000,
      startedAtMs: NOW - 9_000,
    });
    await transaction.insertAttempt({
      id: attemptId,
      runId,
      attempt: 1,
      status: 'running',
      executorType: 'local_process',
      callbackSequence: 0,
      createdAtMs: NOW - 10_000,
      startedAtMs: NOW - 9_000,
      deadlineAtMs: NOW - 1,
    });
  });
  const requester = new PrimaryTimeoutRequester(
    new LegacySequelizePrimaryTimeoutSource(database),
    new RunCommandService(repository),
  );

  const result = await requester.requestBatch({ nowMs: NOW });
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 0);
  const persisted = await repository.findRunById(runId);
  assert.equal(persisted.cancelRequestedAtMs, NOW);
  assert.equal(persisted.cancelReason, 'timeout');
  assert.deepEqual(
    (await repository.listEvents(runId)).map((event) => ({
      type: event.type,
      actorType: event.actorType,
      actorId: event.actorId,
    })),
    [
      {
        type: 'run.cancel_requested',
        actorType: 'system',
        actorId: 'runtime:timeout',
      },
    ],
  );
});

test('persists timeout intent for each due candidate without side effects', async () => {
  const commands = [];
  const requester = new PrimaryTimeoutRequester(
    {
      async listOverdue(options) {
        assert.deepEqual(options, { nowMs: NOW, limit: 8 });
        return page([candidate(1), candidate(2), candidate(3)]);
      },
    },
    {
      async requestCancellation(command) {
        commands.push(command);
        if (command.runId === 'run-1') return { status: 'accepted' };
        if (command.runId === 'run-2') return { status: 'already_requested' };
        return { status: 'already_terminal' };
      },
    },
  );

  const result = await requester.requestBatch({ nowMs: NOW, limit: 8 });
  assert.deepEqual(result, {
    scanned: 3,
    accepted: 1,
    alreadyRequested: 1,
    alreadyTerminal: 1,
    failed: 0,
    truncated: false,
  });
  assert.deepEqual(
    commands.map(({ runId, attemptId, atMs, reason, actor }) => ({
      runId,
      attemptId,
      atMs,
      reason,
      actor,
    })),
    [1, 2, 3].map((index) => ({
      runId: `run-${index}`,
      attemptId: `attempt-${index}`,
      atMs: NOW,
      reason: 'timeout',
      actor: { type: 'system', id: 'runtime:timeout' },
    })),
  );
});

test('isolates candidate failures and refuses future deadline output', async () => {
  let calls = 0;
  const requester = new PrimaryTimeoutRequester(
    {
      async listOverdue() {
        return page([
          candidate(1),
          candidate(2, { deadlineAtMs: NOW + 1 }),
          candidate(3),
        ]);
      },
    },
    {
      async requestCancellation() {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
        return { status: 'accepted' };
      },
    },
  );

  const result = await requester.requestBatch({ nowMs: NOW });
  assert.equal(result.scanned, 3);
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 2);
  assert.equal(calls, 2);
});

test('validates its clock before querying the source', async () => {
  let queried = false;
  const requester = new PrimaryTimeoutRequester(
    {
      async listOverdue() {
        queried = true;
        return page([]);
      },
    },
    { async requestCancellation() {} },
    { now: () => -1 },
  );
  await assert.rejects(requester.requestBatch(), /nowMs/);
  assert.equal(queried, false);
});
