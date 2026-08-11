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
  RemoteRunActivationService,
  RemoteRunActivationStateError,
} = require('../../back/runtime/application/remoteRunActivationService');
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
const {
  RunDispatchLeaseFenceRejectedError,
} = require('../../back/runtime/domain/runDispatchLease');

const START = 1_760_200_000_000;
const SESSION_A = '019f7c00-0000-7000-8000-000000000001';
const SESSION_B = '019f7c00-0000-7000-8000-000000000002';
const TOKEN = 'remote_activation_token_abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_B =
  'remote_activation_token_b_abcdefghijklmnopqrstuvwxyz0123456789';
let idSequence = 3_000;

function nextId() {
  idSequence += 1;
  return `019f7c00-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function capabilities() {
  return {
    architecture: 'arm64',
    operatingSystem: 'linux',
    executors: ['remote_worker'],
    runtimes: [{ name: 'node', version: '24.14.0' }],
    labels: {},
    capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
    features: ['direct_file_log'],
  };
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
  const leases = new LegacySequelizeRunDispatchLeaseRepository(database);
  const workerControl = new WorkerControlService(
    new LegacySequelizeWorkerRegistryRepository(database),
    { leaseDurationMs: 60_000, clock: { now: () => nowMs } },
  );
  const leaseControl = new RunDispatchLeaseService(leases, {
    leaseDurationMs: 5_000,
    clock: { now: () => nowMs },
    createEventId: nextId,
  });
  return {
    database,
    runs,
    leases,
    workerControl,
    leaseControl,
    activation(repository = leases) {
      return new RemoteRunActivationService(repository, {
        clock: { now: () => nowMs },
        createEventId: nextId,
      });
    },
    setNow(value) {
      nowMs = value;
    },
    getNow() {
      return nowMs;
    },
  };
}

async function register(context, sessionId = SESSION_A) {
  return new BoundWorkerControlPlaneClient(context.workerControl, {
    workerId: 'worker-a',
  }).register({
    workerId: 'worker-a',
    sessionId,
    capabilities: capabilities(),
    maxConcurrentRuns: 1,
    availableSlots: 1,
  });
}

async function createRun(context) {
  return new PrimaryRunCreator(context.runs, nextId).create(
    {
      projectId: 'default',
      taskId: `activation:${nextId()}`,
      taskRevision: 'activation-v1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: context.getNow(),
      actor: { type: 'user', id: 'user:1' },
    },
    'remote_worker',
  );
}

async function claim(context, reference, worker, leaseToken = TOKEN) {
  const result = await context.leaseControl.claim(
    { workerId: worker.id },
    {
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      workerId: worker.id,
      workerSessionId: worker.sessionId,
      workerGeneration: worker.generation,
      leaseToken,
    },
  );
  assert.equal(result.status, 'claimed');
  return result;
}

function command(reference, worker, lease, overrides = {}) {
  return {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    workerId: worker.id,
    workerSessionId: worker.sessionId,
    workerGeneration: worker.generation,
    leaseGeneration: lease.leaseGeneration,
    leaseToken: lease.leaseToken,
    expectedLeaseVersion: lease.version,
    executorType: 'remote_worker',
    ...overrides,
  };
}

test('atomically acknowledges starting/running and replays both steps', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  const service = context.activation();

  context.setNow(START + 100);
  const startCommand = command(reference, worker, claimed.lease);
  const starting = await service.acknowledgeStarting(
    { workerId: worker.id },
    startCommand,
  );
  assert.equal(starting.status, 'applied');
  assert.equal(starting.run.status, 'dispatching');
  assert.equal(starting.attempt.status, 'starting');
  assert.equal(starting.attempt.workerId, worker.id);
  assert.equal(starting.lease.version, 0);
  assert.equal(starting.events.length, 1);
  assert.equal(starting.events[0].actorType, 'worker');
  assert.equal(starting.events[0].actorId, worker.id);
  assert.equal(
    (await service.acknowledgeStarting({ workerId: worker.id }, startCommand))
      .status,
    'already_starting',
  );

  context.setNow(START + 200);
  const runningCommand = command(reference, worker, claimed.lease, {
    startedAtMs: START + 150,
    executorHandle: 'remote-worker:durable-handle-1',
    logArtifactId: '019f7c00-0000-7000-8000-000000000099',
  });
  const running = await service.acknowledgeRunning(
    { workerId: worker.id },
    runningCommand,
  );
  assert.equal(running.status, 'applied');
  assert.equal(running.run.status, 'running');
  assert.equal(running.attempt.status, 'running');
  assert.equal(running.attempt.executorHandle, runningCommand.executorHandle);
  assert.equal(running.events.length, 2);
  assert.deepEqual(
    running.events.map((event) => event.type),
    ['attempt.running', 'run.running'],
  );
  assert.equal(
    (await service.acknowledgeRunning({ workerId: worker.id }, runningCommand))
      .status,
    'already_running',
  );
  assert.equal(
    (await service.acknowledgeStarting({ workerId: worker.id }, startCommand))
      .status,
    'already_running',
  );

  const persistedEvents = await context.runs.listEvents(reference.run.id);
  assert.deepEqual(
    persistedEvents.slice(-3).map((event) => event.type),
    ['attempt.starting', 'attempt.running', 'run.running'],
  );
});

test('requires starting acknowledgement before accepting an executor handle', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  context.setNow(START + 100);
  await assert.rejects(
    context.activation().acknowledgeRunning(
      { workerId: worker.id },
      command(reference, worker, claimed.lease, {
        startedAtMs: START + 50,
        executorHandle: 'remote-worker:unexpected',
      }),
    ),
    RemoteRunActivationStateError,
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'dispatching',
  );
  assert.equal(
    (await context.runs.findAttemptById(reference.attempt.id)).status,
    'claimed',
  );
});

test('fences a stale lease version after renewal and accepts the current version', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  context.setNow(START + 500);
  const renewed = await context.leaseControl.renew(
    { workerId: worker.id },
    {
      attemptId: reference.attempt.id,
      workerId: worker.id,
      workerSessionId: worker.sessionId,
      workerGeneration: worker.generation,
      leaseGeneration: claimed.lease.leaseGeneration,
      leaseToken: claimed.lease.leaseToken,
      expectedVersion: claimed.lease.version,
    },
  );
  await assert.rejects(
    context
      .activation()
      .acknowledgeStarting(
        { workerId: worker.id },
        command(reference, worker, claimed.lease),
      ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'version_mismatch',
  );
  const applied = await context
    .activation()
    .acknowledgeStarting(
      { workerId: worker.id },
      command(reference, worker, renewed),
    );
  assert.equal(applied.status, 'applied');
  assert.equal(applied.lease.version, renewed.version);
});

test('rejects expired leases and a replaced Worker session without Run mutation', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const expiredReference = await createRun(context);
  const expiredClaim = await claim(context, expiredReference, worker);
  context.setNow(START + 5_000);
  await assert.rejects(
    context
      .activation()
      .acknowledgeStarting(
        { workerId: worker.id },
        command(expiredReference, worker, expiredClaim.lease),
      ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'lease_expired',
  );

  context.setNow(START + 6_000);
  const currentWorker = await register(context, SESSION_B);
  const replacedReference = await createRun(context);
  const currentClaim = await claim(
    context,
    replacedReference,
    currentWorker,
    TOKEN_B,
  );
  await assert.rejects(
    context.activation().acknowledgeStarting(
      { workerId: worker.id },
      command(replacedReference, worker, {
        ...currentClaim.lease,
        workerSessionId: worker.sessionId,
        workerGeneration: worker.generation,
      }),
    ),
    RunDispatchLeaseFenceRejectedError,
  );
  assert.equal(
    (await context.runs.findAttemptById(replacedReference.attempt.id)).status,
    'claimed',
  );
});

test('atomically records executor start failure and completes the lease', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  const service = context.activation();
  context.setNow(START + 100);
  await service.acknowledgeStarting(
    { workerId: worker.id },
    command(reference, worker, claimed.lease),
  );
  context.setNow(START + 200);
  const failureCommand = command(reference, worker, claimed.lease);
  const failed = await service.failStart(
    { workerId: worker.id },
    failureCommand,
  );
  assert.equal(failed.status, 'applied');
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.attempt.status, 'failed');
  assert.equal(failed.attempt.callbackSequence, 1);
  assert.equal(failed.attempt.errorCode, 'EXECUTOR_START_FAILED');
  assert.equal(failed.lease.status, 'completed');
  assert.equal(failed.lease.version, claimed.lease.version + 1);
  assert.equal(
    (await service.failStart({ workerId: worker.id }, failureCommand)).status,
    'already_terminal',
  );
});

test('lets a cancellation request win over executor start failure', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  const service = context.activation();
  context.setNow(START + 100);
  const starting = await service.acknowledgeStarting(
    { workerId: worker.id },
    command(reference, worker, claimed.lease),
  );
  await new RunCommandService(context.runs, nextId).requestCancellation({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    expectedVersion: starting.run.version,
    reason: 'user',
    atMs: START + 150,
    actor: { type: 'user', id: 'user:1' },
  });
  context.setNow(START + 200);
  const result = await service.failStart(
    { workerId: worker.id },
    command(reference, worker, claimed.lease),
  );
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.attempt.status, 'cancelled');
  assert.equal(result.run.errorCode, 'EXECUTION_CANCELLED');
  assert.equal(result.lease.status, 'completed');
});

test('preserves timeout semantics when timeout wins during executor start', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  const service = context.activation();
  context.setNow(START + 100);
  const starting = await service.acknowledgeStarting(
    { workerId: worker.id },
    command(reference, worker, claimed.lease),
  );
  await new RunCommandService(context.runs, nextId).requestCancellation({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    expectedVersion: starting.run.version,
    reason: 'timeout',
    atMs: START + 150,
    actor: { type: 'system', id: 'timeout-supervisor' },
  });
  context.setNow(START + 200);
  const result = await service.failStart(
    { workerId: worker.id },
    command(reference, worker, claimed.lease),
  );
  assert.equal(result.run.status, 'timed_out');
  assert.equal(result.attempt.status, 'timed_out');
  assert.equal(result.run.errorCode, 'EXECUTION_TIMED_OUT');
  assert.equal(result.lease.status, 'completed');
});

test('rolls back Run, Attempt, events, and lease when start-failure commit crashes', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  context.setNow(START + 100);
  await context
    .activation()
    .acknowledgeStarting(
      { workerId: worker.id },
      command(reference, worker, claimed.lease),
    );
  const eventCount = (await context.runs.listEvents(reference.run.id)).length;
  const crashingRepository = {
    completeWithLease(commandValue, work) {
      return context.leases.completeWithLease(
        commandValue,
        async (transaction, leaseValue) => {
          await work(transaction, leaseValue);
          throw new Error('crash before commit');
        },
      );
    },
  };
  context.setNow(START + 200);
  await assert.rejects(
    context
      .activation(crashingRepository)
      .failStart(
        { workerId: worker.id },
        command(reference, worker, claimed.lease),
      ),
    /crash before commit/,
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'dispatching',
  );
  assert.equal(
    (await context.runs.findAttemptById(reference.attempt.id)).status,
    'starting',
  );
  assert.equal(
    (await context.leases.findByAttemptId(reference.attempt.id)).status,
    'leased',
  );
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    eventCount,
  );
  assert.equal(
    (
      await context
        .activation()
        .failStart(
          { workerId: worker.id },
          command(reference, worker, claimed.lease),
        )
    ).status,
    'applied',
  );
});

test('rolls back both running transitions when the second event write fails', async (t) => {
  const context = await fixture(t);
  const worker = await register(context);
  const reference = await createRun(context);
  const claimed = await claim(context, reference, worker);
  context.setNow(START + 100);
  await context
    .activation()
    .acknowledgeStarting(
      { workerId: worker.id },
      command(reference, worker, claimed.lease),
    );
  const eventCount = (await context.runs.listEvents(reference.run.id)).length;
  const crashingRepository = {
    withLease(commandValue, work) {
      return context.leases.withLease(
        commandValue,
        (transaction, leaseValue) => {
          let appended = 0;
          const failingTransaction = new Proxy(transaction, {
            get(target, property) {
              if (property === 'appendEvent') {
                return async (event) => {
                  appended += 1;
                  if (appended === 2) throw new Error('second event failed');
                  return target.appendEvent(event);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return work(failingTransaction, leaseValue);
        },
      );
    },
  };
  context.setNow(START + 200);
  const runningCommand = command(reference, worker, claimed.lease, {
    startedAtMs: START + 150,
    executorHandle: 'remote-worker:rollback-handle',
  });
  await assert.rejects(
    context
      .activation(crashingRepository)
      .acknowledgeRunning({ workerId: worker.id }, runningCommand),
    /second event failed/,
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'dispatching',
  );
  assert.equal(
    (await context.runs.findAttemptById(reference.attempt.id)).status,
    'starting',
  );
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    eventCount,
  );
  assert.equal(
    (
      await context
        .activation()
        .acknowledgeRunning({ workerId: worker.id }, runningCommand)
    ).status,
    'applied',
  );
});
