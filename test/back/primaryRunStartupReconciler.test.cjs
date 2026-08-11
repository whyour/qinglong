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
  LegacySequelizePrimaryRunRecoverySource,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryRunRecoverySource');
const {
  PrimaryRunStartupReconciler,
} = require('../../back/runtime/application/primaryRunStartupReconciler');

const databases = [];
const BASE_TIME = 1_750_100_000_000;
let idSequence = 1200;

function nextId() {
  idSequence += 1;
  return `019f7100-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
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
    database,
    repository: new LegacySequelizeRunRepository(database),
    source: new LegacySequelizePrimaryRunRecoverySource(database),
  };
}

function createRun(overrides = {}) {
  return {
    id: nextId(),
    projectId: 'default',
    taskId: 'recovery-task',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 5,
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

function inspector(inspect) {
  return {
    executorType: 'local_process',
    inspect,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('scans only active runtime-owned Runs with a bounded stable cursor', async () => {
  const { repository, source } = await createRuntime();
  const first = createRun({ createdAtMs: BASE_TIME });
  const second = createRun({
    status: 'dispatching',
    createdAtMs: BASE_TIME + 1,
    startedAtMs: undefined,
  });
  const terminal = createRun({
    status: 'succeeded',
    createdAtMs: BASE_TIME + 2,
  });
  const legacy = createRun({
    executionOwner: 'legacy',
    createdAtMs: BASE_TIME + 3,
  });
  const firstAttempt = createAttempt(first.id);
  const secondAttempt = createAttempt(second.id);
  await seed(repository, first, [firstAttempt]);
  await seed(repository, second, [secondAttempt]);
  await seed(repository, terminal, [createAttempt(terminal.id)]);
  await seed(repository, legacy, [createAttempt(legacy.id)]);

  const page1 = await source.listCandidates({ limit: 1 });
  assert.equal(page1.truncated, true);
  assert.equal(page1.unsafeAttemptOverflow, false);
  assert.deepEqual(page1.candidates, [
    {
      runId: first.id,
      attempts: [
        {
          attemptId: firstAttempt.id,
          executorType: 'local_process',
        },
      ],
    },
  ]);

  const page2 = await source.listCandidates({
    limit: 1,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.candidates[0].runId, second.id);
  assert.equal(page2.truncated, false);
  await assert.rejects(source.listCandidates({ limit: 65 }), RangeError);
});

test('fails closed when corrupt data exceeds the bounded active-attempt budget', async () => {
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

test('audits a verified running process without changing its status', async () => {
  const { repository, source } = await createRuntime();
  const run = createRun();
  const attempt = createAttempt(run.id);
  await seed(repository, run, [attempt]);
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    source,
    [inspector(async () => ({ status: 'running', identityPid: 4321 }))],
    { clock: { now: () => BASE_TIME + 10 }, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.verifiedRunning, 1);
  assert.equal(summary.markedLost, 0);
  const persisted = await repository.findRunById(run.id);
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.version, 1);
  assert.deepEqual(
    (await repository.listEvents(run.id)).map((event) => event.type),
    ['run.reconciled'],
  );
  assert.deepEqual((await repository.listEvents(run.id))[0].payload, {
    status: 'running',
    executor_type: 'local_process',
    evidence: 'durable_handle',
    version: 1,
  });
});

test('recovers a dispatching Run when its durable Attempt is still running', async () => {
  const { repository, source } = await createRuntime();
  const run = createRun({ status: 'dispatching', startedAtMs: undefined });
  const attempt = createAttempt(run.id);
  await seed(repository, run, [attempt]);
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    source,
    [inspector(async () => ({ status: 'running', identityPid: 4321 }))],
    { clock: { now: () => BASE_TIME + 10 }, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.recoveredRunning, 1);
  assert.equal((await repository.findRunById(run.id)).status, 'running');
  assert.deepEqual(
    (await repository.listEvents(run.id)).map((event) => event.type),
    ['run.running'],
  );
});

test('marks unprovable processes lost without issuing any process action', async () => {
  const { repository, source } = await createRuntime();
  const cases = [
    {
      handle: 'invalid-handle',
      inspection: { status: 'invalid' },
      code: 'RECOVERY_HANDLE_INVALID',
    },
    {
      handle: 'mismatched-handle',
      inspection: { status: 'identity_mismatch', identityPid: 4321 },
      code: 'RECOVERY_IDENTITY_MISMATCH',
    },
    {
      handle: 'unsupported-handle',
      inspection: { status: 'unsupported', identityPid: 4321 },
      code: 'RECOVERY_IDENTITY_UNSUPPORTED',
    },
    {
      handle: 'exited-handle',
      inspection: { status: 'exited', identityPid: 4321 },
      code: 'RECOVERY_PROCESS_EXITED_UNOBSERVED',
    },
    {
      handle: 'reused-pid-handle',
      inspection: { status: 'running', identityPid: 9999 },
      code: 'RECOVERY_IDENTITY_PID_MISMATCH',
    },
  ];
  const inspections = new Map();
  for (const [index, item] of cases.entries()) {
    const run = createRun({ createdAtMs: BASE_TIME + index });
    const attempt = createAttempt(run.id, { executorHandle: item.handle });
    await seed(repository, run, [attempt]);
    inspections.set(item.handle, item.inspection);
    item.run = run;
    item.attempt = attempt;
  }
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    source,
    [inspector(async (handle) => inspections.get(handle))],
    { clock: { now: () => BASE_TIME + 20 }, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.markedLost, cases.length);
  for (const item of cases) {
    const run = await repository.findRunById(item.run.id);
    const attempt = await repository.findAttemptById(item.attempt.id);
    assert.equal(run.status, 'lost');
    assert.equal(attempt.status, 'lost');
    assert.equal(run.errorCode, item.code);
    assert.equal(attempt.errorCode, item.code);
  }
});

test('marks incomplete ownership lost before consulting the OS', async () => {
  const { repository, source } = await createRuntime();
  const run = createRun({ status: 'dispatching', startedAtMs: undefined });
  const attempt = createAttempt(run.id, {
    status: 'starting',
    executorHandle: undefined,
    pid: undefined,
    startedAtMs: undefined,
  });
  await seed(repository, run, [attempt]);
  const missingAttemptRun = createRun({
    status: 'dispatching',
    startedAtMs: undefined,
    createdAtMs: BASE_TIME + 1,
  });
  await seed(repository, missingAttemptRun);
  let inspections = 0;
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    source,
    [
      inspector(async () => {
        inspections += 1;
        return { status: 'running' };
      }),
    ],
    { clock: { now: () => BASE_TIME + 10 }, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.markedLost, 2);
  assert.equal(inspections, 0);
  assert.equal(
    (await repository.findRunById(run.id)).errorCode,
    'RECOVERY_ATTEMPT_INCOMPLETE',
  );
  assert.equal(
    (await repository.findRunById(missingAttemptRun.id)).errorCode,
    'RECOVERY_ATTEMPT_MISSING',
  );
});

test('leaves ambiguous, unsupported, and transient probe failures untouched', async () => {
  const { repository, source } = await createRuntime();
  const ambiguous = createRun({ createdAtMs: BASE_TIME });
  await seed(repository, ambiguous, [
    createAttempt(ambiguous.id, { attempt: 1 }),
    createAttempt(ambiguous.id, { attempt: 2 }),
  ]);
  const unsupported = createRun({ createdAtMs: BASE_TIME + 1 });
  await seed(repository, unsupported, [
    createAttempt(unsupported.id, {
      executorType: 'remote_worker',
      executorHandle: 'remote-handle',
    }),
  ]);
  const transient = createRun({ createdAtMs: BASE_TIME + 2 });
  const transientAttempt = createAttempt(transient.id);
  await seed(repository, transient, [transientAttempt]);
  const healthy = createRun({ createdAtMs: BASE_TIME + 3 });
  const healthyAttempt = createAttempt(healthy.id);
  await seed(repository, healthy, [healthyAttempt]);
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    source,
    [
      inspector(async (handle) => {
        if (handle === transientAttempt.executorHandle) {
          throw new Error('temporary /proc failure');
        }
        return { status: 'running', identityPid: 4321 };
      }),
    ],
    { clock: { now: () => BASE_TIME + 10 }, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.ambiguous, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.verifiedRunning, 1);
  assert.equal((await repository.findRunById(ambiguous.id)).status, 'running');
  assert.equal(
    (await repository.findRunById(unsupported.id)).status,
    'running',
  );
  assert.equal((await repository.findRunById(transient.id)).status, 'running');
  assert.equal((await repository.findRunById(healthy.id)).status, 'running');
  assert.deepEqual(
    (await repository.listEvents(healthy.id)).map((event) => event.type),
    ['run.reconciled'],
  );
});
