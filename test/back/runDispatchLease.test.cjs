require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  LegacySequelizeRunDispatchLeaseExpirySource,
} = require('../../back/runtime/adapters/legacy-sequelize/runDispatchLeaseExpirySource');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  LegacySequelizeWorkerRegistryRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/workerRegistryRepository');
const {
  RemoteRunCompletionService,
} = require('../../back/runtime/application/remoteRunCompletionService');
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
  RunDispatchLeaseExpiryService,
} = require('../../back/runtime/application/runDispatchLeaseExpiryService');
const {
  RunDispatchLeaseExpiryScanner,
} = require('../../back/runtime/application/runDispatchLeaseExpiryScanner');
const {
  BoundWorkerControlPlaneClient,
  WorkerControlService,
} = require('../../back/runtime/application/workerControlService');
const {
  RunDispatchLeaseFenceRejectedError,
} = require('../../back/runtime/domain/runDispatchLease');

const START = 1_750_000_000_000;
const SESSION_A = '019f7800-0000-7000-8000-000000000001';
const SESSION_B = '019f7800-0000-7000-8000-000000000002';
const TOKEN_A = 'lease_token_a_abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_B = 'lease_token_b_abcdefghijklmnopqrstuvwxyz0123456789';
let idSequence = 1_000;

function nextId() {
  idSequence += 1;
  return `019f7800-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function capabilities() {
  return {
    architecture: 'arm64',
    operatingSystem: 'linux',
    executors: ['remote_worker'],
    runtimes: [{ name: 'node', version: '24.14.0' }],
    labels: { tier: 'worker' },
    capacity: { cpuCores: 2, memoryBytes: 512 * 1024 * 1024 },
    features: ['direct_file_log'],
  };
}

const migrationChain = [
  runSchemaMigration,
  runCancellationRequestMigration,
  runAttemptDeadlineMigration,
  workerRegistryMigration,
  runDispatchLeaseMigration,
];

async function setupDatabase(database) {
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: migrationChain,
    logger: { info() {} },
  });
}

async function fixture(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await setupDatabase(database);
  let nowMs = START;
  const workers = new WorkerControlService(
    new LegacySequelizeWorkerRegistryRepository(database),
    { leaseDurationMs: 60_000, clock: { now: () => nowMs } },
  );
  const leases = new LegacySequelizeRunDispatchLeaseRepository(database);
  const leaseService = new RunDispatchLeaseService(leases, {
    leaseDurationMs: 5_000,
    clock: { now: () => nowMs },
    createEventId: nextId,
  });
  const runs = new LegacySequelizeRunRepository(database);
  return {
    database,
    workers,
    leases,
    leaseService,
    runs,
    setNow(value) {
      nowMs = value;
    },
    getNow() {
      return nowMs;
    },
  };
}

async function registerWorker(context, workerId, sessionId, max = 2) {
  return new BoundWorkerControlPlaneClient(context.workers, {
    workerId,
  }).register({
    workerId,
    sessionId,
    capabilities: capabilities(),
    maxConcurrentRuns: max,
    availableSlots: max,
  });
}

async function createRun(context) {
  return new PrimaryRunCreator(context.runs, nextId).create(
    {
      projectId: 'default',
      taskId: `remote-task:${nextId()}`,
      taskRevision: 'remote-revision-1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: context.getNow(),
      actor: { type: 'user', id: 'user:1' },
    },
    'remote_worker',
  );
}

function claimRequest(reference, worker, token) {
  return {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    workerId: worker.id,
    workerSessionId: worker.sessionId,
    workerGeneration: worker.generation,
    leaseToken: token,
  };
}

function fenceRequest(reference, worker, lease) {
  return {
    attemptId: reference.attempt.id,
    workerId: worker.id,
    workerSessionId: worker.sessionId,
    workerGeneration: worker.generation,
    leaseGeneration: lease.leaseGeneration,
    leaseToken: lease.leaseToken,
    expectedVersion: lease.version,
  };
}

async function moveToRunning(context, reference, claimed) {
  const commands = new RunCommandService(context.runs, nextId);
  const starting = await commands.transitionRunAttempt({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    to: 'starting',
    expectedRunVersion: claimed.event.sequence,
    atMs: context.getNow() + 1,
    actor: { type: 'worker', id: claimed.lease.workerId },
  });
  const runningAttempt = await commands.transitionRunAttempt({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    to: 'running',
    expectedRunVersion: starting.run.version,
    atMs: context.getNow() + 2,
    executorHandle: 'remote-worker-handle',
    actor: { type: 'worker', id: claimed.lease.workerId },
  });
  return commands.transitionRun({
    runId: reference.run.id,
    to: 'running',
    expectedVersion: runningAttempt.run.version,
    atMs: context.getNow() + 2,
    actor: { type: 'worker', id: claimed.lease.workerId },
  });
}

test('claims idempotently, renews, releases, and fences an old generation', async (t) => {
  const context = await fixture(t);
  const workerA = await registerWorker(context, 'worker-a', SESSION_A);
  const workerB = await registerWorker(context, 'worker-b', SESSION_B);
  const reference = await createRun(context);
  const requestA = claimRequest(reference, workerA, TOKEN_A);

  const claimed = await context.leaseService.claim(
    { workerId: 'worker-a' },
    requestA,
  );
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.lease.leaseGeneration, 1);
  assert.equal(claimed.lease.version, 0);
  assert.equal(claimed.event.type, 'run.dispatching');
  assert.equal(
    (await context.leaseService.claim({ workerId: 'worker-a' }, requestA))
      .status,
    'idempotent',
  );
  assert.equal(
    (
      await context.leaseService.claim(
        { workerId: 'worker-b' },
        claimRequest(reference, workerB, TOKEN_B),
      )
    ).status,
    'leased',
  );

  context.setNow(START + 1_000);
  const renewed = await context.leaseService.renew(
    { workerId: 'worker-a' },
    fenceRequest(reference, workerA, claimed.lease),
  );
  assert.equal(renewed.version, 1);
  assert.equal(renewed.expiresAtMs, START + 6_000);
  await assert.rejects(
    context.leaseService.renew(
      { workerId: 'worker-a' },
      fenceRequest(reference, workerA, claimed.lease),
    ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'version_mismatch',
  );

  context.setNow(START + 2_000);
  const released = await context.leaseService.release(
    { workerId: 'worker-a' },
    {
      ...fenceRequest(reference, workerA, renewed),
      runId: reference.run.id,
      reason: 'shutdown',
    },
  );
  assert.equal(released.lease.status, 'released');
  assert.equal(released.event.type, 'run.dispatch_released');
  const eventsAfterRelease = await context.runs.listEvents(reference.run.id);

  context.setNow(START + 2_001);
  const releaseReplay = await context.leaseService.release(
    { workerId: 'worker-a' },
    {
      ...fenceRequest(reference, workerA, renewed),
      runId: reference.run.id,
      reason: 'shutdown',
    },
  );
  assert.equal(releaseReplay.lease.status, 'released');
  assert.equal(releaseReplay.event, undefined);
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    eventsAfterRelease.length,
  );

  context.setNow(START + 2_002);
  const reclaimed = await context.leaseService.claim(
    { workerId: 'worker-b' },
    claimRequest(reference, workerB, TOKEN_B),
  );
  assert.equal(reclaimed.status, 'claimed');
  assert.equal(reclaimed.lease.leaseGeneration, 2);
  assert.equal(reclaimed.event.type, 'run.dispatch_reclaimed');
  await assert.rejects(
    context.leaseService.renew(
      { workerId: 'worker-a' },
      fenceRequest(reference, workerA, renewed),
    ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'worker_mismatch',
  );
});

test('bounds active claims by Worker capacity and frees capacity after expiry', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-capacity', SESSION_A, 1);
  const first = await createRun(context);
  const second = await createRun(context);
  assert.equal(
    (
      await context.leaseService.claim(
        { workerId: worker.id },
        claimRequest(first, worker, TOKEN_A),
      )
    ).status,
    'claimed',
  );
  assert.equal(
    (
      await context.leaseService.claim(
        { workerId: worker.id },
        claimRequest(second, worker, TOKEN_B),
      )
    ).status,
    'capacity_exhausted',
  );
  context.setNow(START + 5_001);
  assert.equal(
    (
      await context.leaseService.claim(
        { workerId: worker.id },
        claimRequest(second, worker, TOKEN_B),
      )
    ).status,
    'claimed',
  );
});

test('keeps exact claim replay idempotent after capacity drops or drain begins', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-replay', SESSION_A, 1);
  const first = await createRun(context);
  const second = await createRun(context);
  const request = claimRequest(first, worker, TOKEN_A);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    request,
  );
  assert.equal(claimed.status, 'claimed');

  context.setNow(START + 100);
  const client = new BoundWorkerControlPlaneClient(context.workers, {
    workerId: worker.id,
  });
  const noCapacity = await client.heartbeat({
    workerId: worker.id,
    sessionId: worker.sessionId,
    generation: worker.generation,
    expectedVersion: worker.version,
    availableSlots: 0,
  });
  assert.equal(
    (await context.leaseService.claim({ workerId: worker.id }, request)).status,
    'idempotent',
  );
  assert.equal(
    (
      await context.leaseService.claim(
        { workerId: worker.id },
        claimRequest(second, worker, TOKEN_B),
      )
    ).status,
    'worker_unavailable',
  );

  context.setNow(START + 200);
  await client.drain({
    workerId: worker.id,
    sessionId: worker.sessionId,
    generation: worker.generation,
    expectedVersion: noCapacity.version,
  });
  assert.equal(
    (await context.leaseService.claim({ workerId: worker.id }, request)).status,
    'idempotent',
  );
  const renewed = await context.leaseService.renew(
    { workerId: worker.id },
    fenceRequest(first, worker, claimed.lease),
  );
  assert.equal(renewed.version, claimed.lease.version + 1);
});

test('reclaims an expired unstarted Attempt and permanently fences the old token', async (t) => {
  const context = await fixture(t);
  const workerA = await registerWorker(context, 'worker-expired-a', SESSION_A);
  const workerB = await registerWorker(context, 'worker-expired-b', SESSION_B);
  const reference = await createRun(context);
  const first = await context.leaseService.claim(
    { workerId: workerA.id },
    claimRequest(reference, workerA, TOKEN_A),
  );
  assert.equal(first.status, 'claimed');

  context.setNow(START + 5_001);
  const replacement = await context.leaseService.claim(
    { workerId: workerB.id },
    claimRequest(reference, workerB, TOKEN_B),
  );
  assert.equal(replacement.status, 'claimed');
  assert.equal(replacement.lease.leaseGeneration, 2);
  assert.equal(replacement.event.payload.previous_state, 'expired');
  await assert.rejects(
    context.leaseService.renew(
      { workerId: workerA.id },
      fenceRequest(reference, workerA, first.lease),
    ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'worker_mismatch',
  );
});

test('atomically releases an expired running lease and marks Attempt and Run lost', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-expiry', SESSION_A);
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  context.setNow(START + 5_001);
  const service = new RunDispatchLeaseExpiryService(context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  });

  const expired = await service.reconcile(
    reference.run.id,
    reference.attempt.id,
  );
  assert.equal(expired.status, 'lost');
  assert.equal(expired.run.status, 'lost');
  assert.equal(expired.attempt.status, 'lost');
  assert.equal(expired.lease.status, 'released');
  assert.equal(expired.lease.releaseReason, 'lease_expired');
  const events = await context.runs.listEvents(reference.run.id);
  assert.deepEqual(
    events.slice(-2).map((event) => [
      event.type,
      event.actorType,
      event.payload.lease_generation,
    ]),
    [
      ['attempt.lost', 'reconciler', claimed.lease.leaseGeneration],
      ['run.lost', 'reconciler', claimed.lease.leaseGeneration],
    ],
  );

  const replay = await service.reconcile(
    reference.run.id,
    reference.attempt.id,
  );
  assert.equal(replay.status, 'already_expired');
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    events.length,
  );
});

test('does not expire a live lease and rolls back when lost reconciliation fails', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(
    context,
    'worker-expiry-rollback',
    SESSION_A,
  );
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  const service = new RunDispatchLeaseExpiryService(context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  });
  assert.equal(
    (await service.reconcile(reference.run.id, reference.attempt.id)).status,
    'not_due',
  );

  context.setNow(START + 5_001);
  await assert.rejects(
    context.leases.expireWithLease(
      {
        runId: reference.run.id,
        attemptId: reference.attempt.id,
        observedAtMs: context.getNow(),
      },
      async (transaction) => {
        const run = await transaction.findRunById(reference.run.id);
        await transaction.compareAndSetRun(
          { ...run, version: run.version + 1 },
          run.version,
        );
        throw new Error('simulated expiry crash');
      },
    ),
    /simulated expiry crash/,
  );
  assert.equal(
    (await context.leases.findByAttemptId(reference.attempt.id)).status,
    'leased',
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'running',
  );
  assert.equal(
    (await service.reconcile(reference.run.id, reference.attempt.id)).status,
    'lost',
  );
});

test('releases expired authority but leaves an accepted cancellation to its own lifecycle', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(
    context,
    'worker-expiry-cancel',
    SESSION_A,
  );
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  const commands = new RunCommandService(context.runs, nextId);
  await commands.requestCancellation({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    atMs: START + 3,
    reason: 'user',
    actor: { type: 'user', id: 'user:1' },
  });
  context.setNow(START + 5_001);
  const result = await new RunDispatchLeaseExpiryService(context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  }).reconcile(reference.run.id, reference.attempt.id);
  assert.equal(result.status, 'cancellation_pending');
  assert.equal(result.run.status, 'running');
  assert.equal(result.attempt.status, 'running');
  assert.equal(result.lease.releaseReason, 'lease_expired');
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).cancelReason,
    'user',
  );
});

test('releases an expired unstarted authority without marking the Attempt lost', async (t) => {
  const context = await fixture(t);
  const workerA = await registerWorker(
    context,
    'worker-expiry-unstarted-a',
    SESSION_A,
  );
  const workerB = await registerWorker(
    context,
    'worker-expiry-unstarted-b',
    SESSION_B,
  );
  const reference = await createRun(context);
  await context.leaseService.claim(
    { workerId: workerA.id },
    claimRequest(reference, workerA, TOKEN_A),
  );
  context.setNow(START + 5_001);
  const result = await new RunDispatchLeaseExpiryService(context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  }).reconcile(reference.run.id, reference.attempt.id);
  assert.equal(result.status, 'unstarted_released');
  assert.equal(result.run.status, 'dispatching');
  assert.equal(result.attempt.status, 'claimed');
  assert.equal(result.lease.releaseReason, 'lease_expired');

  context.setNow(START + 5_002);
  const replacement = await context.leaseService.claim(
    { workerId: workerB.id },
    claimRequest(reference, workerB, TOKEN_B),
  );
  assert.equal(replacement.status, 'claimed');
  assert.equal(replacement.lease.leaseGeneration, 2);
});

test('scans expired leases in bounded stable pages without touching a live lease', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(
    context,
    'worker-expiry-scanner',
    SESSION_A,
    3,
  );
  const references = [];
  for (let index = 0; index < 3; index += 1) {
    references.push(await createRun(context));
  }
  const claims = [];
  for (const [index, reference] of references.entries()) {
    claims.push(
      await context.leaseService.claim(
        { workerId: worker.id },
        claimRequest(
          reference,
          worker,
          `scanner_lease_${index}_abcdefghijklmnopqrstuvwxyz0123456789`,
        ),
      ),
    );
  }
  context.setNow(START + 100);
  const live = await context.leaseService.renew(
    { workerId: worker.id },
    fenceRequest(references[2], worker, claims[2].lease),
  );
  context.setNow(START + 5_001);
  const scanner = new RunDispatchLeaseExpiryScanner(
    new LegacySequelizeRunDispatchLeaseExpirySource(context.database),
    new RunDispatchLeaseExpiryService(context.leases, {
      clock: { now: () => context.getNow() },
      createEventId: nextId,
    }),
    { clock: { now: () => context.getNow() } },
  );

  const first = await scanner.scan({ limit: 1 });
  assert.equal(first.scanned, 1);
  assert.equal(first.counts.unstarted_released, 1);
  assert.equal(first.truncated, true);
  assert.ok(first.nextCursor);
  const second = await scanner.scan({ after: first.nextCursor, limit: 1 });
  assert.equal(second.scanned, 1);
  assert.equal(second.counts.unstarted_released, 1);
  const final = await scanner.scan({
    after: second.nextCursor,
    limit: 1,
  });
  assert.equal(final.scanned, 0);
  assert.equal(final.truncated, false);
  assert.equal(
    (await context.leases.findByAttemptId(references[2].attempt.id)).version,
    live.version,
  );
  assert.equal(
    (await context.leases.findByAttemptId(references[2].attempt.id)).status,
    'leased',
  );
});

test('commits remote completion and lease completion atomically with replay', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-complete', SESSION_A);
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  assert.equal(claimed.status, 'claimed');
  await moveToRunning(context, reference, claimed);
  context.setNow(START + 10);
  const service = new RemoteRunCompletionService(context.runs, context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  });
  const command = {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    callbackSequence: 1,
    result: {
      outcome: 'succeeded',
      startedAtMs: START + 2,
      finishedAtMs: START + 9,
      exitCode: 0,
    },
    executorType: 'remote_worker',
    workerId: worker.id,
    workerSessionId: worker.sessionId,
    workerGeneration: worker.generation,
    leaseGeneration: claimed.lease.leaseGeneration,
    leaseToken: claimed.lease.leaseToken,
    expectedLeaseVersion: claimed.lease.version,
  };
  const applied = await service.complete({ workerId: worker.id }, command);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.run.status, 'succeeded');
  assert.equal(
    (await context.leases.findByAttemptId(reference.attempt.id)).status,
    'completed',
  );
  const events = await context.runs.listEvents(reference.run.id);
  assert.deepEqual(
    events
      .slice(-2)
      .map((event) => [event.type, event.actorType, event.actorId]),
    [
      ['attempt.succeeded', 'worker', worker.id],
      ['run.succeeded', 'worker', worker.id],
    ],
  );
  assert.equal(
    (await service.complete({ workerId: worker.id }, command)).status,
    'already_terminal',
  );
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    events.length,
  );
});

test('accepts only an exact completion replay after the Worker session is replaced', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(
    context,
    'worker-completion-replay',
    SESSION_A,
  );
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  const command = {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    callbackSequence: 1,
    result: {
      outcome: 'succeeded',
      startedAtMs: START + 2,
      finishedAtMs: START + 9,
      exitCode: 0,
    },
    executorType: 'remote_worker',
    workerId: worker.id,
    workerSessionId: worker.sessionId,
    workerGeneration: worker.generation,
    leaseGeneration: claimed.lease.leaseGeneration,
    leaseToken: claimed.lease.leaseToken,
    expectedLeaseVersion: claimed.lease.version,
  };
  const service = new RemoteRunCompletionService(context.runs, context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  });

  context.setNow(START + 20);
  assert.equal(
    (await service.complete({ workerId: worker.id }, command)).status,
    'applied',
  );
  const events = await context.runs.listEvents(reference.run.id);

  context.setNow(START + 21);
  await registerWorker(context, worker.id, SESSION_B);
  context.setNow(START + 10);
  assert.equal(
    (await service.complete({ workerId: worker.id }, command)).status,
    'already_terminal',
  );
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    events.length,
  );

  await assert.rejects(
    service.complete(
      { workerId: worker.id },
      { ...command, callbackSequence: 2 },
    ),
    /Primary completion callback sequence is invalid/,
  );
  await assert.rejects(
    service.complete(
      { workerId: worker.id },
      {
        ...command,
        result: { ...command.result, outcome: 'failed', exitCode: 9 },
      },
    ),
    /Primary completion target state is inconsistent/,
  );
  await assert.rejects(
    service.complete(
      { workerId: worker.id },
      { ...command, leaseToken: TOKEN_B },
    ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'lease_token_mismatch',
  );
});

test('rolls back Run and lease when completion crashes before commit', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-crash', SESSION_A);
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  context.setNow(START + 10);
  let fail = true;
  const failingLeases = {
    findByAttemptId: (...args) => context.leases.findByAttemptId(...args),
    claim: (...args) => context.leases.claim(...args),
    renew: (...args) => context.leases.renew(...args),
    release: (...args) => context.leases.release(...args),
    completeWithLease(command, work) {
      return context.leases.completeWithLease(
        command,
        async (transaction, lease) => {
          const value = await work(transaction, lease);
          if (fail) {
            fail = false;
            throw new Error('simulated crash before commit');
          }
          return value;
        },
      );
    },
  };
  const command = {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    callbackSequence: 1,
    result: {
      outcome: 'succeeded',
      startedAtMs: START + 2,
      finishedAtMs: START + 9,
      exitCode: 0,
    },
    executorType: 'remote_worker',
    workerId: worker.id,
    workerSessionId: worker.sessionId,
    workerGeneration: worker.generation,
    leaseGeneration: claimed.lease.leaseGeneration,
    leaseToken: claimed.lease.leaseToken,
    expectedLeaseVersion: claimed.lease.version,
  };
  const failing = new RemoteRunCompletionService(context.runs, failingLeases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  });
  await assert.rejects(
    failing.complete({ workerId: worker.id }, command),
    /simulated crash/,
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'running',
  );
  assert.equal(
    (await context.leases.findByAttemptId(reference.attempt.id)).status,
    'leased',
  );
  assert.equal(
    (
      await new RemoteRunCompletionService(context.runs, context.leases, {
        clock: { now: () => context.getNow() },
        createEventId: nextId,
      }).complete({ workerId: worker.id }, command)
    ).status,
    'applied',
  );
});

test('rejects a wrong completion token without mutating Run or lease', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-token', SESSION_A);
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  context.setNow(START + 10);
  const beforeEvents = await context.runs.listEvents(reference.run.id);
  const service = new RemoteRunCompletionService(context.runs, context.leases, {
    clock: { now: () => context.getNow() },
    createEventId: nextId,
  });
  await assert.rejects(
    service.complete(
      { workerId: worker.id },
      {
        runId: reference.run.id,
        attemptId: reference.attempt.id,
        callbackSequence: 1,
        result: {
          outcome: 'succeeded',
          startedAtMs: START + 2,
          finishedAtMs: START + 9,
          exitCode: 0,
        },
        executorType: 'remote_worker',
        workerId: worker.id,
        workerSessionId: worker.sessionId,
        workerGeneration: worker.generation,
        leaseGeneration: claimed.lease.leaseGeneration,
        leaseToken: TOKEN_B,
        expectedLeaseVersion: claimed.lease.version,
      },
    ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'lease_token_mismatch',
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'running',
  );
  assert.equal(
    (await context.leases.findByAttemptId(reference.attempt.id)).status,
    'leased',
  );
  assert.equal(
    (await context.runs.listEvents(reference.run.id)).length,
    beforeEvents.length,
  );
});

test('rejects completion from a replaced Worker session', async (t) => {
  const context = await fixture(t);
  const worker = await registerWorker(context, 'worker-replaced', SESSION_A);
  const reference = await createRun(context);
  const claimed = await context.leaseService.claim(
    { workerId: worker.id },
    claimRequest(reference, worker, TOKEN_A),
  );
  await moveToRunning(context, reference, claimed);
  context.setNow(START + 5);
  await registerWorker(context, worker.id, SESSION_B);
  const service = new RemoteRunCompletionService(context.runs, context.leases, {
    clock: { now: () => START + 10 },
    createEventId: nextId,
  });
  await assert.rejects(
    service.complete(
      { workerId: worker.id },
      {
        runId: reference.run.id,
        attemptId: reference.attempt.id,
        callbackSequence: 1,
        result: {
          outcome: 'succeeded',
          startedAtMs: START + 2,
          finishedAtMs: START + 9,
          exitCode: 0,
        },
        executorType: 'remote_worker',
        workerId: worker.id,
        workerSessionId: worker.sessionId,
        workerGeneration: worker.generation,
        leaseGeneration: claimed.lease.leaseGeneration,
        leaseToken: claimed.lease.leaseToken,
        expectedLeaseVersion: claimed.lease.version,
      },
    ),
    (error) =>
      error instanceof RunDispatchLeaseFenceRejectedError &&
      error.reason === 'worker_unavailable',
  );
  assert.equal(
    (await context.runs.findRunById(reference.run.id)).status,
    'running',
  );
});

test('serializes two control-plane claims for one Attempt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-run-leases-'));
  const storage = path.join(root, 'leases.sqlite');
  const databases = [
    new Sequelize({ dialect: 'sqlite', storage, logging: false }),
    new Sequelize({ dialect: 'sqlite', storage, logging: false }),
  ];
  t.after(async () => {
    await Promise.all(databases.map((database) => database.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await setupDatabase(databases[0]);
  for (const database of databases) {
    await database.query('PRAGMA journal_mode=WAL');
    await database.query('PRAGMA busy_timeout=1000');
  }
  let nowMs = START;
  const workerService = new WorkerControlService(
    new LegacySequelizeWorkerRegistryRepository(databases[0]),
    { leaseDurationMs: 60_000, clock: { now: () => nowMs } },
  );
  const context = {
    workers: workerService,
    runs: new LegacySequelizeRunRepository(databases[0]),
    getNow: () => nowMs,
  };
  const workerA = await registerWorker(context, 'worker-race-a', SESSION_A);
  const workerB = await registerWorker(context, 'worker-race-b', SESSION_B);
  const reference = await createRun(context);
  const services = databases.map(
    (database) =>
      new RunDispatchLeaseService(
        new LegacySequelizeRunDispatchLeaseRepository(database),
        {
          leaseDurationMs: 5_000,
          clock: { now: () => nowMs },
          createEventId: nextId,
        },
      ),
  );
  const results = await Promise.all([
    services[0].claim(
      { workerId: workerA.id },
      claimRequest(reference, workerA, TOKEN_A),
    ),
    services[1].claim(
      { workerId: workerB.id },
      claimRequest(reference, workerB, TOKEN_B),
    ),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    'claimed',
    'leased',
  ]);
});
