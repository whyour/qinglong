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
  completionReceiptJournalMigration,
} = require('../../back/migrations/0007-completion-receipt-journal');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeCompletionReceiptJournal,
} = require('../../back/runtime/adapters/legacy-sequelize/completionReceiptJournal');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  CompletionReceiptFileStore,
} = require('../../back/runtime/adapters/fs/completionReceiptFileStore');
const {
  PrimaryCompletionReceiptConsumer,
} = require('../../back/runtime/application/primaryCompletionReceiptConsumer');
const {
  PrimaryCompletionReceiptJournalScanner,
} = require('../../back/runtime/application/primaryCompletionReceiptJournalScanner');
const {
  PrimaryRunCompletionService,
  hashPrimaryCompletionToken,
} = require('../../back/runtime/application/primaryRunCompletionService');

const NOW = 1_750_900_000_000;
const TOKEN = 'j'.repeat(43);
let sequence = 2_400;

function nextId() {
  sequence += 1;
  return `019f7900-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

async function setup(t) {
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
      completionReceiptJournalMigration,
    ],
    logger: { info() {} },
  });
  return {
    repository: new LegacySequelizeRunRepository(database),
    journal: new LegacySequelizeCompletionReceiptJournal(database),
  };
}

async function seed(repository, status = 'running', finishedAtMs) {
  const run = {
    id: nextId(),
    projectId: 'default',
    taskId: 'journal-test',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: status === 'running' ? 'running' : 'succeeded',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: NOW,
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
  };
  const attempt = {
    id: nextId(),
    runId: run.id,
    attempt: 1,
    status,
    executorType: 'local_process',
    callbackSequence: status === 'running' ? 0 : 1,
    callbackTokenHash: hashPrimaryCompletionToken(TOKEN),
    createdAtMs: NOW,
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
  };
  await repository.transaction(async (transaction) => {
    await transaction.insertRun(run);
    await transaction.insertAttempt(attempt);
  });
  return { run, attempt };
}

test('registers idempotently and lists active and terminal pending receipts', async (t) => {
  const { repository, journal } = await setup(t);
  const active = await seed(repository);
  const terminal = await seed(repository, 'succeeded', NOW + 20);
  for (const aggregate of [active, terminal]) {
    await journal.register({
      runId: aggregate.run.id,
      attemptId: aggregate.attempt.id,
      registeredAtMs: NOW + 1,
    });
  }
  await journal.register({
    runId: active.run.id,
    attemptId: active.attempt.id,
    registeredAtMs: NOW + 1,
  });

  const page = await journal.listCandidates({
    observedAtMs: NOW + 100,
    limit: 8,
  });
  assert.equal(page.candidates.length, 2);
  assert.deepEqual(
    page.candidates.map((candidate) => candidate.attemptStatus).sort(),
    ['running', 'succeeded'],
  );
});

test('defers quarantined entries until purge time and resolves idempotently', async (t) => {
  const { repository, journal } = await setup(t);
  const aggregate = await seed(repository);
  await journal.register({
    runId: aggregate.run.id,
    attemptId: aggregate.attempt.id,
    registeredAtMs: NOW,
  });
  await journal.markQuarantined({
    attemptId: aggregate.attempt.id,
    quarantineRef: `.quarantine/${aggregate.attempt.id.slice(0, 2)}/${
      aggregate.attempt.id
    }.json`,
    updatedAtMs: NOW + 1,
    purgeAfterMs: NOW + 100,
  });

  assert.equal(
    (await journal.listCandidates({ observedAtMs: NOW + 99 })).candidates
      .length,
    0,
  );
  const due = await journal.listCandidates({ observedAtMs: NOW + 100 });
  assert.equal(due.candidates[0].state, 'quarantined');
  assert.equal(await journal.resolve(aggregate.attempt.id), true);
  assert.equal(await journal.resolve(aggregate.attempt.id), false);
});

test('finds and cleans a receipt after the Run already became terminal', async (t) => {
  const { repository, journal } = await setup(t);
  const aggregate = await seed(repository);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-journal-replay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CompletionReceiptFileStore(root);
  await journal.register({
    runId: aggregate.run.id,
    attemptId: aggregate.attempt.id,
    registeredAtMs: aggregate.attempt.createdAtMs,
  });
  await store.publish({
    schemaVersion: 1,
    runId: aggregate.run.id,
    attemptId: aggregate.attempt.id,
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: NOW + 1,
    finishedAtMs: NOW + 20,
    exitCode: 0,
  });
  const completions = new PrimaryRunCompletionService(repository, nextId);
  await completions.complete({
    runId: aggregate.run.id,
    attemptId: aggregate.attempt.id,
    callbackSequence: 1,
    source: { kind: 'executor', executorType: 'local_process' },
    result: {
      outcome: 'succeeded',
      startedAtMs: NOW + 1,
      finishedAtMs: NOW + 20,
      exitCode: 0,
    },
  });

  const consumer = new PrimaryCompletionReceiptConsumer(store, completions, {
    journal,
    clock: { now: () => NOW + 30 },
  });
  const scanner = new PrimaryCompletionReceiptJournalScanner(
    journal,
    store,
    consumer,
    { clock: { now: () => NOW + 30 } },
  );
  const summary = await scanner.scanBatch();
  assert.equal(summary.alreadyTerminal, 1);
  assert.equal(summary.failed, 0);
  assert.equal(await store.read(aggregate.attempt.id), undefined);
  assert.equal(
    (await journal.listCandidates({ observedAtMs: NOW + 30 })).candidates
      .length,
    0,
  );
});
