require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  RUN_ATTEMPT_TABLE,
  RUN_EVENT_TABLE,
  RUN_TABLE,
  runSchemaMigration,
} = require('../../back/migrations/0002-run-schema');
const {
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  runCancellationDispatchMigration,
  RUN_CANCELLATION_DISPATCH_TABLE,
} = require('../../back/migrations/0005-run-cancellation-dispatch');
const {
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeCancellationDispatchRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/cancellationDispatchRepository');
const {
  CancellationDispatchBindingConflictError,
  CancellationDispatchFenceRejectedError,
  CancellationDispatchRepositoryError,
} = require('../../back/runtime/domain/cancellationDispatchErrors');
const {
  PrimaryCancellationDispatcher,
} = require('../../back/runtime/application/primaryCancellationDispatcher');

const databases = [];
let idSequence = 200;

function nextId() {
  idSequence += 1;
  return `019f71c0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

async function createRepository() {
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
      runCancellationDispatchMigration,
      runAttemptDeadlineMigration,
    ],
    logger: { info() {} },
  });
  databases.push(database);
  return {
    database,
    repository: new LegacySequelizeCancellationDispatchRepository(database),
  };
}

async function insertCandidate(database, overrides = {}) {
  const queryInterface = database.getQueryInterface();
  const runId = overrides.runId ?? nextId();
  const attemptId = overrides.attemptId ?? nextId();
  const requestedAtMs = overrides.requestedAtMs ?? 1_750_000_000_100;
  await queryInterface.bulkInsert(RUN_TABLE, [
    {
      id: runId,
      project_id: 'default',
      task_id: `task:${runId}`,
      task_revision: 'revision-1',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: overrides.executionOwner ?? 'runtime',
      status: overrides.runStatus ?? 'running',
      version: 2,
      event_sequence: 0,
      priority: 0,
      created_at_ms: 1_750_000_000_000,
      started_at_ms: 1_750_000_000_010,
      cancel_requested_at_ms:
        overrides.cancelRequestedAtMs === undefined
          ? requestedAtMs
          : overrides.cancelRequestedAtMs,
      cancel_reason: 'user',
    },
  ]);
  await queryInterface.bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: attemptId,
      run_id: runId,
      attempt: 1,
      status: overrides.attemptStatus ?? 'running',
      executor_type: 'local_process',
      callback_sequence: 0,
      created_at_ms: 1_750_000_000_010,
    },
  ]);
  return { runId, attemptId, requestedAtMs };
}

function claim(candidate, overrides = {}) {
  return {
    ...candidate,
    owner: 'worker-a',
    leaseToken: 'lease-a',
    nowMs: candidate.requestedAtMs,
    leaseDurationMs: 50,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('fences two workers and lets a second worker recover an expired lease', async () => {
  const { database, repository } = await createRepository();
  const candidate = await insertCandidate(database);

  const first = await repository.claim(claim(candidate));
  assert.equal(first.status, 'claimed');
  assert.equal(first.dispatch.version, 1);
  assert.equal(first.dispatch.dispatchCount, 1);
  assert.equal(first.dispatch.leaseOwner, 'worker-a');

  const competing = await repository.claim(
    claim(candidate, {
      owner: 'worker-b',
      leaseToken: 'lease-b',
      nowMs: candidate.requestedAtMs + 25,
    }),
  );
  assert.equal(competing.status, 'leased');
  assert.equal(competing.dispatch.leaseOwner, 'worker-a');

  const recovered = await repository.claim(
    claim(candidate, {
      owner: 'worker-b',
      leaseToken: 'lease-b',
      nowMs: candidate.requestedAtMs + 50,
    }),
  );
  assert.equal(recovered.status, 'claimed');
  assert.equal(recovered.dispatch.version, 2);
  assert.equal(recovered.dispatch.dispatchCount, 2);
  assert.equal(recovered.dispatch.leaseOwner, 'worker-b');

  await assert.rejects(
    repository.recordResult({
      runId: candidate.runId,
      attemptId: candidate.attemptId,
      owner: 'worker-a',
      leaseToken: 'lease-a',
      expectedVersion: 1,
      result: 'termination_requested',
      atMs: candidate.requestedAtMs + 51,
      eventId: nextId(),
    }),
    CancellationDispatchFenceRejectedError,
  );

  const recorded = await repository.recordResult({
    runId: candidate.runId,
    attemptId: candidate.attemptId,
    owner: 'worker-b',
    leaseToken: 'lease-b',
    expectedVersion: recovered.dispatch.version,
    result: 'termination_requested',
    atMs: candidate.requestedAtMs + 52,
    eventId: nextId(),
  });
  assert.equal(recorded.dispatch.status, 'dispatched');
  assert.equal(recorded.dispatch.version, 3);
  assert.equal(recorded.event.type, 'run.cancel_dispatched');
  assert.deepEqual(recorded.event.payload, {
    attempt_id: candidate.attemptId,
    dispatch_count: 2,
    result: 'termination_requested',
  });

  const terminal = await repository.claim(
    claim(candidate, {
      owner: 'worker-c',
      leaseToken: 'lease-c',
      nowMs: candidate.requestedAtMs + 100,
    }),
  );
  assert.equal(terminal.status, 'dispatched');
});

test('persists retry backoff and only reclaims when it becomes due', async () => {
  const { database, repository } = await createRepository();
  const candidate = await insertCandidate(database);
  const leased = await repository.claim(claim(candidate));
  const retryAtMs = candidate.requestedAtMs + 1_000;

  const failed = await repository.recordResult({
    runId: candidate.runId,
    attemptId: candidate.attemptId,
    owner: 'worker-a',
    leaseToken: 'lease-a',
    expectedVersion: leased.dispatch.version,
    result: 'dispatch_error',
    atMs: candidate.requestedAtMs + 1,
    nextAttemptAtMs: retryAtMs,
    eventId: nextId(),
  });
  assert.equal(failed.dispatch.status, 'retry_wait');
  assert.equal(failed.dispatch.nextAttemptAtMs, retryAtMs);
  assert.equal(failed.event.type, 'run.cancel_dispatch_failed');

  const early = await repository.claim(
    claim(candidate, {
      owner: 'worker-b',
      leaseToken: 'lease-b',
      nowMs: retryAtMs - 1,
    }),
  );
  assert.equal(early.status, 'not_due');

  const retry = await repository.claim(
    claim(candidate, {
      owner: 'worker-b',
      leaseToken: 'lease-b',
      nowMs: retryAtMs,
    }),
  );
  assert.equal(retry.status, 'claimed');
  assert.equal(retry.dispatch.dispatchCount, 2);

  const missingController = await repository.recordResult({
    runId: candidate.runId,
    attemptId: candidate.attemptId,
    owner: 'worker-b',
    leaseToken: 'lease-b',
    expectedVersion: retry.dispatch.version,
    result: 'controller_missing',
    atMs: retryAtMs + 1,
    nextAttemptAtMs: retryAtMs + 2_000,
    eventId: nextId(),
  });
  assert.equal(missingController.dispatch.status, 'retry_wait');
  assert.equal(
    missingController.dispatch.lastDispatchedAtMs,
    failed.dispatch.lastDispatchedAtMs,
  );
});

test('fails closed for stale candidates and conflicting Attempt bindings', async () => {
  const { database, repository } = await createRepository();
  const stale = await insertCandidate(database, { runStatus: 'succeeded' });
  assert.deepEqual(await repository.claim(claim(stale)), {
    status: 'not_eligible',
  });
  assert.equal(await repository.findByRunId(stale.runId), null);

  const candidate = await insertCandidate(database);
  await repository.claim(claim(candidate));
  const secondAttemptId = nextId();
  await database.getQueryInterface().bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: secondAttemptId,
      run_id: candidate.runId,
      attempt: 2,
      status: 'running',
      executor_type: 'local_process',
      callback_sequence: 0,
      created_at_ms: candidate.requestedAtMs + 1,
    },
  ]);
  await assert.rejects(
    repository.claim(
      claim(
        { ...candidate, attemptId: secondAttemptId },
        {
          owner: 'worker-b',
          leaseToken: 'lease-b',
          nowMs: candidate.requestedAtMs + 50,
        },
      ),
    ),
    CancellationDispatchBindingConflictError,
  );
});

test('rolls back dispatch state and Run version when event append fails', async () => {
  const { database, repository } = await createRepository();
  const candidate = await insertCandidate(database);
  const leased = await repository.claim(claim(candidate));
  const duplicateEventId = nextId();
  await database.getQueryInterface().bulkInsert(RUN_EVENT_TABLE, [
    {
      id: duplicateEventId,
      run_id: candidate.runId,
      sequence: 99,
      type: 'fixture.event',
      dedupe_key: 'fixture-event',
      actor_type: 'system',
      payload: '{}',
      created_at_ms: candidate.requestedAtMs,
    },
  ]);

  await assert.rejects(
    repository.recordResult({
      runId: candidate.runId,
      attemptId: candidate.attemptId,
      owner: 'worker-a',
      leaseToken: 'lease-a',
      expectedVersion: leased.dispatch.version,
      result: 'already_exited',
      atMs: candidate.requestedAtMs + 1,
      eventId: duplicateEventId,
    }),
  );
  const afterFailure = await repository.findByRunId(candidate.runId);
  assert.equal(afterFailure.status, 'leased');
  assert.equal(afterFailure.version, leased.dispatch.version);

  const [run] = await database.query(
    `SELECT version, event_sequence FROM ${RUN_TABLE} WHERE id = :runId`,
    {
      replacements: { runId: candidate.runId },
      type: QueryTypes.SELECT,
    },
  );
  assert.deepEqual(run, { version: 2, event_sequence: 0 });

  const recovered = await repository.recordResult({
    runId: candidate.runId,
    attemptId: candidate.attemptId,
    owner: 'worker-a',
    leaseToken: 'lease-a',
    expectedVersion: leased.dispatch.version,
    result: 'already_exited',
    atMs: candidate.requestedAtMs + 2,
    eventId: nextId(),
  });
  assert.equal(recovered.dispatch.status, 'dispatched');
});

test('allows only one of two dispatchers to signal the same persisted Attempt', async () => {
  const { database, repository } = await createRepository();
  const candidate = await insertCandidate(database);
  const source = {
    async listCandidates() {
      return {
        candidates: [
          {
            runId: candidate.runId,
            requestedAtMs: candidate.requestedAtMs,
            reason: 'user',
            attempts: [
              {
                attemptId: candidate.attemptId,
                executorType: 'local_process',
                executorHandle: 'durable-handle',
                pid: 4100,
              },
            ],
          },
        ],
        truncated: false,
        unsafeAttemptOverflow: false,
      };
    },
  };
  let stopCalls = 0;
  const controller = {
    executorType: 'local_process',
    async stop() {
      stopCalls += 1;
      return {
        status: 'termination_requested',
        termSignalSent: true,
        killSignalSent: false,
      };
    },
  };
  function options(owner) {
    return {
      owner,
      clock: () => candidate.requestedAtMs + 1,
      createId: nextId,
    };
  }
  const workerA = new PrimaryCancellationDispatcher(
    source,
    repository,
    [controller],
    options('worker-a'),
  );
  const workerB = new PrimaryCancellationDispatcher(
    source,
    repository,
    [controller],
    options('worker-b'),
  );

  const first = await workerA.dispatchBatch();
  const second = await workerB.dispatchBatch();
  assert.equal(first.terminationRequested, 1);
  assert.equal(second.alreadyResolved, 1);
  assert.equal(stopCalls, 1);
});

test('fails closed instead of reclaiming a corrupt persisted lease', async () => {
  const { database, repository } = await createRepository();
  const candidate = await insertCandidate(database);
  await database
    .getQueryInterface()
    .bulkInsert(RUN_CANCELLATION_DISPATCH_TABLE, [
      {
        run_id: candidate.runId,
        attempt_id: candidate.attemptId,
        status: 'leased',
        version: 1,
        dispatch_count: 1,
        lease_owner: 'worker-a',
        lease_token: null,
        lease_expires_at_ms: candidate.requestedAtMs - 1,
        created_at_ms: candidate.requestedAtMs - 100,
        updated_at_ms: candidate.requestedAtMs - 50,
      },
    ]);

  await assert.rejects(
    repository.claim(
      claim(candidate, {
        owner: 'worker-b',
        leaseToken: 'lease-b',
        nowMs: candidate.requestedAtMs,
      }),
    ),
    CancellationDispatchRepositoryError,
  );
});
