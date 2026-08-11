require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  CompletionReceiptFileStore,
} = require('../../back/runtime/adapters/fs/completionReceiptFileStore');
const {
  LegacySequelizePrimaryRunRecoverySource,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryRunRecoverySource');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  PrimaryCompletionReceiptConsumer,
} = require('../../back/runtime/application/primaryCompletionReceiptConsumer');
const {
  hashPrimaryCompletionToken,
  PrimaryRunCompletionService,
} = require('../../back/runtime/application/primaryRunCompletionService');
const {
  PrimaryRunStartupReconciler,
} = require('../../back/runtime/application/primaryRunStartupReconciler');

const BASE_TIME = 1_750_300_000_000;
const TOKEN = 'c'.repeat(43);
const databases = [];
const roots = [];
let idSequence = 1_800;

function nextId() {
  idSequence += 1;
  return `019f7400-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-startup-receipt-'));
  roots.push(root);
  const repository = new LegacySequelizeRunRepository(database);
  const store = new CompletionReceiptFileStore(root);
  const consumer = new PrimaryCompletionReceiptConsumer(
    store,
    new PrimaryRunCompletionService(repository, nextId),
  );
  return { database, repository, store, consumer };
}

function aggregate() {
  const run = {
    id: nextId(),
    projectId: 'default',
    taskId: 'receipt-recovery',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 1,
  };
  const attempt = {
    id: nextId(),
    runId: run.id,
    attempt: 1,
    status: 'running',
    executorType: 'local_process',
    executorHandle: `durable:${run.id}`,
    pid: 4321,
    callbackTokenHash: hashPrimaryCompletionToken(TOKEN),
    callbackSequence: 0,
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 1,
  };
  return { run, attempt };
}

function receipt(run, attempt) {
  return {
    schemaVersion: 1,
    runId: run.id,
    attemptId: attempt.id,
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: BASE_TIME + 1,
    finishedAtMs: BASE_TIME + 20,
    exitCode: 0,
  };
}

async function seed(repository, run, attempt) {
  await repository.transaction(async (transaction) => {
    await transaction.insertRun(run);
    await transaction.insertAttempt(attempt);
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test('startup consumes a receipt before consulting durable identity', async () => {
  const { database, repository, store, consumer } = await createRuntime();
  const { run, attempt } = aggregate();
  await seed(repository, run, attempt);
  await store.publish(receipt(run, attempt));
  let inspections = 0;
  const registrations = [];
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    new LegacySequelizePrimaryRunRecoverySource(database),
    [
      {
        executorType: 'local_process',
        async inspect() {
          inspections += 1;
          return { status: 'exited', identityPid: 4321 };
        },
      },
    ],
    {
      completionReceipts: consumer,
      completionReceiptJournal: {
        async register(command) {
          registrations.push(command);
        },
      },
      createEventId: nextId,
    },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.completedFromReceipt, 1);
  assert.equal(summary.markedLost, 0);
  assert.equal(inspections, 0);
  assert.deepEqual(registrations, [
    {
      runId: run.id,
      attemptId: attempt.id,
      registeredAtMs: attempt.createdAtMs,
    },
  ]);
  assert.equal((await repository.findRunById(run.id)).status, 'succeeded');
  assert.equal(
    (await repository.findAttemptById(attempt.id)).status,
    'succeeded',
  );
  assert.equal(await store.read(attempt.id), undefined);
});

test('startup rechecks a receipt after identity reports process exit', async () => {
  const { database, repository, store, consumer } = await createRuntime();
  const { run, attempt } = aggregate();
  await seed(repository, run, attempt);
  let inspections = 0;
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    new LegacySequelizePrimaryRunRecoverySource(database),
    [
      {
        executorType: 'local_process',
        async inspect() {
          inspections += 1;
          await store.publish(receipt(run, attempt));
          return { status: 'exited', identityPid: 4321 };
        },
      },
    ],
    { completionReceipts: consumer, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.completedFromReceipt, 1);
  assert.equal(summary.markedLost, 0);
  assert.equal(inspections, 1);
  assert.equal((await repository.findRunById(run.id)).status, 'succeeded');
  assert.equal(await store.read(attempt.id), undefined);
});

test('startup waits once for a late receipt after observing process exit', async () => {
  const { database, repository, store, consumer } = await createRuntime();
  const { run, attempt } = aggregate();
  await seed(repository, run, attempt);
  const waits = [];
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    new LegacySequelizePrimaryRunRecoverySource(database),
    [
      {
        executorType: 'local_process',
        async inspect() {
          return { status: 'exited', identityPid: 4321 };
        },
      },
    ],
    {
      completionReceipts: consumer,
      createEventId: nextId,
      receiptPublishGraceMs: 50,
      async wait(delayMs) {
        waits.push(delayMs);
        await store.publish(receipt(run, attempt));
      },
    },
  );

  const summary = await reconciler.reconcileBatch();
  assert.deepEqual(waits, [50]);
  assert.equal(summary.publishGraceWaits, 1);
  assert.equal(summary.completedFromReceipt, 1);
  assert.equal(summary.markedLost, 0);
  assert.equal((await repository.findRunById(run.id)).status, 'succeeded');
});

test('startup quarantines an unauthorized receipt and still verifies the process', async () => {
  const { database, repository, store, consumer } = await createRuntime();
  const { run, attempt } = aggregate();
  await seed(repository, run, attempt);
  await store.publish({
    ...receipt(run, attempt),
    token: 'd'.repeat(43),
  });
  const reconciler = new PrimaryRunStartupReconciler(
    repository,
    new LegacySequelizePrimaryRunRecoverySource(database),
    [
      {
        executorType: 'local_process',
        async inspect() {
          return { status: 'running', identityPid: 4321 };
        },
      },
    ],
    { completionReceipts: consumer, createEventId: nextId },
  );

  const summary = await reconciler.reconcileBatch();
  assert.equal(summary.quarantinedReceipts, 1);
  assert.equal(summary.completedFromReceipt, 0);
  assert.equal(summary.verifiedRunning, 1);
  assert.equal(summary.markedLost, 0);
  assert.equal((await repository.findRunById(run.id)).status, 'running');
  assert.equal(await store.read(attempt.id), undefined);
});
