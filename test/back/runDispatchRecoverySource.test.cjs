require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
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
const {
  workerRegistryMigration,
} = require('../../back/migrations/0008-worker-registry');
const {
  runDispatchLeaseMigration,
} = require('../../back/migrations/0009-run-dispatch-lease');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunDispatchRecoverySource,
} = require('../../back/runtime/adapters/legacy-sequelize/runDispatchRecoverySource');
const {
  LegacySequelizeRunDispatchLeaseRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runDispatchLeaseRepository');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  LegacySequelizeWorkerRegistryRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/workerRegistryRepository');
const {
  PrimaryRunCreator,
} = require('../../back/runtime/application/primaryRunCreator');
const {
  RunDispatchLeaseService,
} = require('../../back/runtime/application/runDispatchLeaseService');
const {
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');
const {
  BoundWorkerControlPlaneClient,
  WorkerControlService,
} = require('../../back/runtime/application/workerControlService');

const START = 1_760_100_000_000;
const SESSION_A = '019f7c00-0000-7000-8000-000000000001';
const SESSION_B = '019f7c00-0000-7000-8000-000000000002';
let idSequence = 3_000;

function nextId() {
  idSequence += 1;
  return `019f7c00-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function leaseToken(sequence) {
  return `recovery_lease_${String(sequence).padStart(
    2,
    '0',
  )}_abcdefghijklmnopqrstuvwxyz0123456789`;
}

async function fixture(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      runSchemaMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
      workerRegistryMigration,
      runDispatchLeaseMigration,
    ],
    logger: { info() {} },
  });
  let nowMs = START;
  const runs = new LegacySequelizeRunRepository(database);
  const workers = new LegacySequelizeWorkerRegistryRepository(database);
  const workerService = new WorkerControlService(workers, {
    leaseDurationMs: 60_000,
    clock: { now: () => nowMs },
  });
  const leaseService = new RunDispatchLeaseService(
    new LegacySequelizeRunDispatchLeaseRepository(database),
    {
      leaseDurationMs: 5_000,
      clock: { now: () => nowMs },
      createEventId: nextId,
    },
  );
  const workerClient = new BoundWorkerControlPlaneClient(workerService, {
    workerId: 'worker-recovery',
  });
  const worker = await workerClient.register({
    workerId: 'worker-recovery',
    sessionId: SESSION_A,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { cpuCores: 2, memoryBytes: 512 * 1024 * 1024 },
      features: [],
    },
    maxConcurrentRuns: 2,
    availableSlots: 2,
  });
  return {
    database,
    runs,
    worker,
    workerClient,
    leaseService,
    source: new LegacySequelizeRunDispatchRecoverySource(database),
    setNow(value) {
      nowMs = value;
    },
  };
}

async function createAndClaim(context, sequence) {
  const reference = await new PrimaryRunCreator(context.runs, nextId).create(
    {
      projectId: 'default',
      taskId: `recovery-task-${sequence}`,
      taskRevision: `revision-${sequence}`,
      triggerType: 'manual',
      executionOrigin: 'manual',
      priority: sequence,
      acceptedAtMs: START,
      actor: { type: 'user', id: 'user:1' },
    },
    'remote_worker',
  );
  const claim = await context.leaseService.claim(
    { workerId: context.worker.id },
    {
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      workerId: context.worker.id,
      workerSessionId: context.worker.sessionId,
      workerGeneration: context.worker.generation,
      leaseToken: leaseToken(sequence),
    },
  );
  assert.equal(claim.status, 'claimed');
  return { reference, lease: claim.lease };
}

test('recovers active claims with pinned Task identity and stable pagination', async (t) => {
  const context = await fixture(t);
  const first = await createAndClaim(context, 1);
  const second = await createAndClaim(context, 2);

  const firstPage = await context.source.listRecoverable({
    observedAtMs: START,
    limit: 1,
  });
  assert.equal(firstPage.length, 1);
  assert.deepEqual(
    {
      projectId: firstPage[0].candidate.projectId,
      taskId: firstPage[0].candidate.taskId,
      taskRevision: firstPage[0].candidate.taskRevision,
      executorType: firstPage[0].candidate.executorType,
    },
    {
      projectId: 'default',
      taskId:
        firstPage[0].candidate.runId === first.reference.run.id
          ? 'recovery-task-1'
          : 'recovery-task-2',
      taskRevision:
        firstPage[0].candidate.runId === first.reference.run.id
          ? 'revision-1'
          : 'revision-2',
      executorType: 'remote_worker',
    },
  );
  assert.equal(firstPage[0].lease.status, 'leased');

  const secondPage = await context.source.listRecoverable({
    observedAtMs: START,
    after: {
      expiresAtMs: firstPage[0].lease.expiresAtMs,
      attemptId: firstPage[0].candidate.attemptId,
    },
    limit: 1,
  });
  assert.equal(secondPage.length, 1);
  assert.notEqual(
    secondPage[0].candidate.attemptId,
    firstPage[0].candidate.attemptId,
  );
  assert.deepEqual(
    new Set([firstPage[0].candidate.runId, secondPage[0].candidate.runId]),
    new Set([first.reference.run.id, second.reference.run.id]),
  );
  await assert.rejects(
    context.source.listRecoverable({ observedAtMs: START, limit: 65 }),
    /between 1 and 64/,
  );
});

test('excludes expired leases and leases fenced by Worker session replacement', async (t) => {
  const expiredContext = await fixture(t);
  await createAndClaim(expiredContext, 3);
  expiredContext.setNow(START + 5_000);
  assert.deepEqual(
    await expiredContext.source.listRecoverable({
      observedAtMs: START + 5_000,
    }),
    [],
  );

  const replacedContext = await fixture(t);
  await createAndClaim(replacedContext, 4);
  await replacedContext.workerClient.register({
    workerId: 'worker-recovery',
    sessionId: SESSION_B,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { cpuCores: 2, memoryBytes: 512 * 1024 * 1024 },
      features: [],
    },
    maxConcurrentRuns: 2,
    availableSlots: 2,
  });
  assert.deepEqual(
    await replacedContext.source.listRecoverable({ observedAtMs: START }),
    [],
  );
});

test('does not redeliver an active lease after cancellation is requested', async (t) => {
  const context = await fixture(t);
  const { reference } = await createAndClaim(context, 5);
  await new RunCommandService(context.runs, nextId).requestCancellation({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    expectedVersion: reference.run.version + 1,
    reason: 'user',
    atMs: START + 1,
    actor: { type: 'user', id: 'user:1' },
  });
  assert.deepEqual(
    await context.source.listRecoverable({ observedAtMs: START + 1 }),
    [],
  );
});

test('rejects accidental cluster-control use of the SQLite recovery source', () => {
  assert.throws(
    () =>
      new LegacySequelizeRunDispatchRecoverySource({
        getDialect: () => 'postgres',
      }),
    /PostgreSQL adapter/,
  );
});
