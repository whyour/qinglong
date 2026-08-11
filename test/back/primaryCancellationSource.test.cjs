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
  LegacySequelizePrimaryCancellationSource,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryCancellationSource');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');

const databases = [];
const BASE_TIME = 1_750_200_000_000;
let idSequence = 1_500;

function nextId() {
  idSequence += 1;
  return `019f7130-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

async function createRuntime() {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const migrationModel = defineSchemaMigrationModel(database);
  await runMigrations({
    database,
    migrationModel,
    migrations: [
      runSchemaMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
    ],
    logger: { info() {} },
  });
  databases.push(database);
  return {
    repository: new LegacySequelizeRunRepository(database),
    source: new LegacySequelizePrimaryCancellationSource(database),
  };
}

function createRun(overrides = {}) {
  return {
    id: nextId(),
    projectId: 'default',
    taskId: 'cancel-task',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 7,
    eventSequence: 7,
    priority: 0,
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 5,
    cancelRequestedAtMs: BASE_TIME + 10,
    cancelReason: 'user',
    ...overrides,
  };
}

function createAttempt(runId, overrides = {}) {
  return {
    id: nextId(),
    runId,
    attempt: 1,
    status: 'running',
    executorType: 'local_process',
    executorHandle: `durable:${runId}`,
    pid: 4321,
    callbackSequence: 0,
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 5,
    ...overrides,
  };
}

async function seed(repository, run, attempts = []) {
  await repository.transaction(async (transaction) => {
    await transaction.insertRun(run);
    for (const attempt of attempts) await transaction.insertAttempt(attempt);
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('pages only runtime-owned non-terminal cancellation requests', async () => {
  const { repository, source } = await createRuntime();
  const first = createRun();
  const second = createRun({
    status: 'dispatching',
    startedAtMs: undefined,
    cancelRequestedAtMs: BASE_TIME + 11,
    cancelReason: 'shutdown',
  });
  const terminal = createRun({
    status: 'cancelled',
    cancelRequestedAtMs: BASE_TIME + 9,
  });
  const legacy = createRun({
    executionOwner: 'legacy',
    cancelRequestedAtMs: BASE_TIME + 8,
  });
  const untouched = createRun({
    cancelRequestedAtMs: undefined,
    cancelReason: undefined,
  });
  const firstAttempt = createAttempt(first.id);
  const secondAttempt = createAttempt(second.id, {
    status: 'starting',
    pid: undefined,
  });
  await seed(repository, first, [firstAttempt]);
  await seed(repository, second, [secondAttempt]);
  await seed(repository, terminal, [createAttempt(terminal.id)]);
  await seed(repository, legacy, [createAttempt(legacy.id)]);
  await seed(repository, untouched, [createAttempt(untouched.id)]);

  const page1 = await source.listCandidates({ limit: 1 });
  assert.equal(page1.truncated, true);
  assert.deepEqual(page1.candidates, [
    {
      runId: first.id,
      requestedAtMs: BASE_TIME + 10,
      reason: 'user',
      attempts: [
        {
          attemptId: firstAttempt.id,
          executorType: 'local_process',
          executorHandle: `durable:${first.id}`,
          pid: 4321,
        },
      ],
    },
  ]);

  const page2 = await source.listCandidates({
    limit: 1,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.truncated, false);
  assert.equal(page2.candidates[0].runId, second.id);
  assert.equal(page2.candidates[0].reason, 'shutdown');
  assert.equal(page2.candidates[0].attempts[0].pid, undefined);
  await assert.rejects(source.listCandidates({ limit: 65 }), RangeError);
});

test('fails closed when active Attempt corruption exceeds the bounded budget', async () => {
  const { repository, source } = await createRuntime();
  const run = createRun();
  await seed(repository, run, [
    createAttempt(run.id, { attempt: 1 }),
    createAttempt(run.id, { attempt: 2 }),
    createAttempt(run.id, { attempt: 3 }),
  ]);

  const page = await source.listCandidates({ limit: 1 });
  assert.equal(page.unsafeAttemptOverflow, true);
  assert.deepEqual(page.candidates, []);
  assert.equal(page.nextCursor, undefined);
});
