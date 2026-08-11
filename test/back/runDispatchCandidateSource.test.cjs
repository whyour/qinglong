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
const {
  RUN_DISPATCH_CANDIDATE_ATTEMPT_INDEX,
  RUN_DISPATCH_CANDIDATE_RUN_INDEX,
  runDispatchCandidateMigration,
} = require('../../back/migrations/0010-run-dispatch-candidates');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunDispatchCandidateSource,
} = require('../../back/runtime/adapters/legacy-sequelize/runDispatchCandidateSource');
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
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');
const {
  RunDispatchLeaseService,
} = require('../../back/runtime/application/runDispatchLeaseService');
const {
  BoundWorkerControlPlaneClient,
  WorkerControlService,
} = require('../../back/runtime/application/workerControlService');

const START = 1_760_000_000_000;
const SESSION = '019f7a00-0000-7000-8000-000000000001';
const TOKEN = 'candidate_lease_token_abcdefghijklmnopqrstuvwxyz0123456789';
let idSequence = 2_000;

function nextId() {
  idSequence += 1;
  return `019f7a00-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
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
      runDispatchCandidateMigration,
    ],
    logger: { info() {} },
  });
  const runs = new LegacySequelizeRunRepository(database);
  const source = new LegacySequelizeRunDispatchCandidateSource(database);
  let nowMs = START;
  return {
    database,
    runs,
    source,
    setNow(value) {
      nowMs = value;
    },
    getNow() {
      return nowMs;
    },
  };
}

async function createRun(context, { priority, atMs }) {
  return new PrimaryRunCreator(context.runs, nextId).create(
    {
      projectId: 'default',
      taskId: `candidate:${nextId()}`,
      taskRevision: 'candidate-v1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      priority,
      acceptedAtMs: atMs,
      actor: { type: 'user', id: 'user:1' },
    },
    'remote_worker',
  );
}

function cursor(candidate) {
  return {
    priority: candidate.priority,
    queuedAtMs: candidate.queuedAtMs,
    attemptCreatedAtMs: candidate.attemptCreatedAtMs,
    attemptId: candidate.attemptId,
  };
}

test('lists a bounded, stable priority/FIFO candidate page', async (t) => {
  const context = await fixture(t);
  const low = await createRun(context, { priority: 0, atMs: START });
  const highOld = await createRun(context, { priority: 10, atMs: START + 1 });
  const highNew = await createRun(context, { priority: 10, atMs: START + 2 });

  const first = await context.source.listCandidates({
    observedAtMs: START + 10,
    limit: 2,
  });
  assert.deepEqual(
    first.map((candidate) => candidate.runId),
    [highOld.run.id, highNew.run.id],
  );
  const second = await context.source.listCandidates({
    observedAtMs: START + 10,
    after: cursor(first[1]),
    limit: 2,
  });
  assert.deepEqual(
    second.map((candidate) => candidate.runId),
    [low.run.id],
  );
  assert.equal(first[0].executorType, 'remote_worker');
  assert.deepEqual(
    {
      projectId: first[0].projectId,
      taskId: first[0].taskId,
      taskRevision: first[0].taskRevision,
    },
    {
      projectId: highOld.run.projectId,
      taskId: highOld.run.taskId,
      taskRevision: highOld.run.taskRevision,
    },
  );
  await assert.rejects(
    context.source.listCandidates({ observedAtMs: START, limit: 65 }),
    /between 1 and 64/,
  );
});

test('discovery never grants ownership and only expired/released claims reappear', async (t) => {
  const context = await fixture(t);
  const reference = await createRun(context, { priority: 1, atMs: START });
  const workerService = new WorkerControlService(
    new LegacySequelizeWorkerRegistryRepository(context.database),
    { leaseDurationMs: 60_000, clock: { now: () => context.getNow() } },
  );
  const worker = await new BoundWorkerControlPlaneClient(workerService, {
    workerId: 'worker-a',
  }).register({
    workerId: 'worker-a',
    sessionId: SESSION,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
      features: [],
    },
    maxConcurrentRuns: 1,
    availableSlots: 1,
  });
  const leaseService = new RunDispatchLeaseService(
    new LegacySequelizeRunDispatchLeaseRepository(context.database),
    {
      leaseDurationMs: 5_000,
      clock: { now: () => context.getNow() },
      createEventId: nextId,
    },
  );
  assert.equal(
    (await context.source.listCandidates({ observedAtMs: START })).length,
    1,
  );
  const claimed = await leaseService.claim(
    { workerId: worker.id },
    {
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      workerId: worker.id,
      workerSessionId: worker.sessionId,
      workerGeneration: worker.generation,
      leaseToken: TOKEN,
    },
  );
  assert.equal(claimed.status, 'claimed');
  assert.deepEqual(
    await context.source.listCandidates({ observedAtMs: START + 4_999 }),
    [],
  );
  context.setNow(START + 5_000);
  assert.deepEqual(
    (await context.source.listCandidates({ observedAtMs: START + 5_000 })).map(
      (candidate) => candidate.attemptId,
    ),
    [reference.attempt.id],
  );
});

test('excludes cancellation requests and owns supporting indexes', async (t) => {
  const context = await fixture(t);
  const reference = await createRun(context, { priority: 1, atMs: START });
  const commands = new RunCommandService(context.runs, nextId);
  await commands.requestCancellation({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    expectedVersion: reference.run.version,
    reason: 'user',
    atMs: START + 1,
    actor: { type: 'user', id: 'user:1' },
  });
  assert.deepEqual(
    await context.source.listCandidates({ observedAtMs: START + 1 }),
    [],
  );
  const runIndexes = await context.database
    .getQueryInterface()
    .showIndex('Runs');
  const attemptIndexes = await context.database
    .getQueryInterface()
    .showIndex('RunAttempts');
  assert.ok(
    runIndexes.some((index) => index.name === RUN_DISPATCH_CANDIDATE_RUN_INDEX),
  );
  assert.ok(
    attemptIndexes.some(
      (index) => index.name === RUN_DISPATCH_CANDIDATE_ATTEMPT_INDEX,
    ),
  );
});

test('rejects accidental cluster-control use of the SQLite source', () => {
  assert.throws(
    () =>
      new LegacySequelizeRunDispatchCandidateSource({
        getDialect() {
          return 'postgres';
        },
      }),
    /SQLite-only/,
  );
});
