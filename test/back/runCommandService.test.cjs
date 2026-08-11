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
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');
const {
  RunAttemptNotFoundError,
  RunNotFoundError,
} = require('../../back/runtime/application/commandErrors');
const {
  DuplicateRunEventError,
  RunRepositoryConstraintError,
} = require('../../back/runtime/domain/repositoryErrors');
const {
  RunVersionConflictError,
} = require('../../back/runtime/domain/stateMachineErrors');

const databases = [];
const CREATED_AT_MS = 1_750_000_000_000;
let idSequence = 200;

function nextId() {
  idSequence += 1;
  return `019f70d0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

async function createRepository() {
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
  return new LegacySequelizeRunRepository(database);
}

function createRun(overrides = {}) {
  return {
    id: nextId(),
    projectId: 'default',
    taskId: 'legacy-cron:1',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'created',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: CREATED_AT_MS,
    ...overrides,
  };
}

function createAttempt(runId, overrides = {}) {
  return {
    id: nextId(),
    runId,
    attempt: 1,
    status: 'claimed',
    executorType: 'legacy_local',
    callbackSequence: 0,
    createdAtMs: CREATED_AT_MS + 1,
    ...overrides,
  };
}

async function seed(repository, run, attempt) {
  await repository.transaction(async (transaction) => {
    await transaction.insertRun(run);
    if (attempt) await transaction.insertAttempt(attempt);
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('atomically persists a Run transition and its ordered event', async () => {
  const repository = await createRepository();
  const run = createRun();
  const eventId = nextId();
  const service = new RunCommandService(repository, () => eventId);
  await seed(repository, run);

  const result = await service.transitionRun({
    runId: run.id,
    to: 'queued',
    expectedVersion: 0,
    atMs: CREATED_AT_MS + 1,
    actor: { type: 'user', id: 'user:1' },
  });

  assert.equal(result.run.status, 'queued');
  assert.equal(result.run.version, 1);
  assert.equal(result.run.eventSequence, 1);
  assert.deepEqual(await repository.findRunById(run.id), result.run);
  assert.deepEqual(await repository.listEvents(run.id), [
    {
      id: eventId,
      runId: run.id,
      sequence: 1,
      type: 'run.queued',
      dedupeKey: 'run-transition:0:queued',
      actorType: 'user',
      actorId: 'user:1',
      payload: {
        from_status: 'created',
        to_status: 'queued',
        version: 1,
      },
      createdAtMs: CREATED_AT_MS + 1,
    },
  ]);
});

test('rolls back the state update when event persistence fails', async () => {
  const repository = await createRepository();
  const run = createRun();
  const duplicateEventId = nextId();
  const service = new RunCommandService(repository, () => duplicateEventId);
  await seed(repository, run);

  await service.transitionRun({
    runId: run.id,
    to: 'queued',
    expectedVersion: 0,
    atMs: CREATED_AT_MS + 1,
    actor: { type: 'system' },
  });
  await assert.rejects(
    service.transitionRun({
      runId: run.id,
      to: 'dispatching',
      expectedVersion: 1,
      atMs: CREATED_AT_MS + 2,
      actor: { type: 'scheduler' },
    }),
    DuplicateRunEventError,
  );

  const persisted = await repository.findRunById(run.id);
  assert.equal(persisted.status, 'queued');
  assert.equal(persisted.version, 1);
  assert.equal(persisted.eventSequence, 1);
  assert.equal((await repository.listEvents(run.id)).length, 1);
});

test('atomically persists an Attempt transition, Run CAS, and event', async () => {
  const repository = await createRepository();
  const run = createRun({
    status: 'dispatching',
    version: 2,
    eventSequence: 2,
  });
  const attempt = createAttempt(run.id);
  const eventId = nextId();
  const service = new RunCommandService(repository, () => eventId);
  await seed(repository, run, attempt);

  const result = await service.transitionRunAttempt({
    runId: run.id,
    attemptId: attempt.id,
    to: 'starting',
    expectedRunVersion: 2,
    atMs: CREATED_AT_MS + 2,
    deadlineAtMs: CREATED_AT_MS + 30_000,
    actor: { type: 'worker', id: 'worker:edge-1' },
  });

  assert.equal(result.run.status, 'dispatching');
  assert.equal(result.run.version, 3);
  assert.equal(result.run.eventSequence, 3);
  assert.equal(result.attempt.status, 'starting');
  assert.equal(result.attempt.deadlineAtMs, CREATED_AT_MS + 30_000);
  assert.deepEqual(await repository.findRunById(run.id), result.run);
  assert.deepEqual(
    await repository.findAttemptById(attempt.id),
    result.attempt,
  );
  assert.deepEqual(await repository.listEvents(run.id), [
    {
      id: eventId,
      runId: run.id,
      sequence: 3,
      type: 'attempt.starting',
      dedupeKey: `attempt-transition:${attempt.id}:2:starting`,
      actorType: 'worker',
      actorId: 'worker:edge-1',
      attemptId: attempt.id,
      payload: {
        attempt_id: attempt.id,
        attempt: 1,
        from_status: 'claimed',
        to_status: 'starting',
        version: 3,
        deadline_at_ms: CREATED_AT_MS + 30_000,
      },
      createdAtMs: CREATED_AT_MS + 2,
    },
  ]);
});

test('persists one idempotent cancellation request and its audit event', async () => {
  const repository = await createRepository();
  const run = createRun({
    status: 'running',
    version: 6,
    eventSequence: 6,
    startedAtMs: CREATED_AT_MS + 5,
  });
  const attempt = createAttempt(run.id, {
    status: 'running',
    startedAtMs: CREATED_AT_MS + 4,
  });
  const eventId = nextId();
  const service = new RunCommandService(repository, () => eventId);
  await seed(repository, run, attempt);

  const accepted = await service.requestCancellation({
    runId: run.id,
    attemptId: attempt.id,
    atMs: CREATED_AT_MS + 10,
    reason: 'user',
    actor: { type: 'user', id: 'user:1' },
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.run.status, 'running');
  assert.equal(accepted.run.version, 7);
  assert.equal(accepted.run.cancelRequestedAtMs, CREATED_AT_MS + 10);
  assert.equal(accepted.run.cancelReason, 'user');

  const duplicate = await service.requestCancellation({
    runId: run.id,
    attemptId: attempt.id,
    atMs: CREATED_AT_MS + 11,
    reason: 'policy',
    actor: { type: 'system' },
  });
  assert.equal(duplicate.status, 'already_requested');
  assert.equal(duplicate.run.version, 7);
  assert.equal(duplicate.run.cancelReason, 'user');
  assert.deepEqual(await repository.listEvents(run.id), [
    {
      id: eventId,
      runId: run.id,
      sequence: 7,
      type: 'run.cancel_requested',
      dedupeKey: `run-cancel-request:${attempt.id}`,
      actorType: 'user',
      actorId: 'user:1',
      attemptId: attempt.id,
      payload: {
        status: 'running',
        reason: 'user',
        requested_at_ms: CREATED_AT_MS + 10,
        version: 7,
      },
      createdAtMs: CREATED_AT_MS + 10,
    },
  ]);
});

test('refuses cancellation after the Attempt reached a terminal state', async () => {
  const repository = await createRepository();
  const run = createRun({
    status: 'running',
    version: 7,
    eventSequence: 7,
    startedAtMs: CREATED_AT_MS + 5,
  });
  const attempt = createAttempt(run.id, {
    status: 'succeeded',
    startedAtMs: CREATED_AT_MS + 4,
    finishedAtMs: CREATED_AT_MS + 9,
    exitCode: 0,
  });
  const service = new RunCommandService(repository, nextId);
  await seed(repository, run, attempt);

  const result = await service.requestCancellation({
    runId: run.id,
    attemptId: attempt.id,
    atMs: CREATED_AT_MS + 10,
    reason: 'user',
    actor: { type: 'user' },
  });
  assert.equal(result.status, 'already_terminal');
  assert.equal((await repository.findRunById(run.id)).version, 7);
  assert.deepEqual(await repository.listEvents(run.id), []);
});

test('rejects missing aggregates and stale command versions without side effects', async () => {
  const repository = await createRepository();
  const service = new RunCommandService(repository, nextId);
  const run = createRun();
  await seed(repository, run);

  await assert.rejects(
    service.transitionRun({
      runId: '019f70d0-0000-7000-8000-000000999999',
      to: 'queued',
      expectedVersion: 0,
      atMs: CREATED_AT_MS + 1,
      actor: { type: 'user' },
    }),
    RunNotFoundError,
  );
  await assert.rejects(
    service.transitionRun({
      runId: run.id,
      to: 'queued',
      expectedVersion: 1,
      atMs: CREATED_AT_MS + 1,
      actor: { type: 'user' },
    }),
    RunVersionConflictError,
  );
  await assert.rejects(
    service.transitionRunAttempt({
      runId: run.id,
      attemptId: '019f70d0-0000-7000-8000-000000999998',
      to: 'starting',
      expectedRunVersion: 0,
      atMs: CREATED_AT_MS + 1,
      actor: { type: 'worker' },
    }),
    RunAttemptNotFoundError,
  );

  assert.deepEqual(await repository.findRunById(run.id), run);
  assert.deepEqual(await repository.listEvents(run.id), []);
});

test('enforces repository compare-and-set preconditions and stale predicates', async () => {
  const repository = await createRepository();
  const run = createRun();
  const attempt = createAttempt(run.id);
  await seed(repository, run, attempt);

  await repository.transaction(async (transaction) => {
    await assert.rejects(
      transaction.compareAndSetRun({ ...run, version: 3 }, 0),
      RunRepositoryConstraintError,
    );
    assert.equal(
      await transaction.compareAndSetRun({ ...run, version: 2 }, 1),
      false,
    );
    assert.equal(
      await transaction.compareAndSetAttempt(
        { ...attempt, status: 'starting' },
        { status: 'running', callbackSequence: 0 },
      ),
      false,
    );
  });

  assert.deepEqual(await repository.findRunById(run.id), run);
  assert.deepEqual(await repository.findAttemptById(attempt.id), attempt);
});
