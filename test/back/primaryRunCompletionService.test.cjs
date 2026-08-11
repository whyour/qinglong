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
const { runMigrations } = require('../../back/migrations/runner');
const {
  CompletionReceiptFileStore,
} = require('../../back/runtime/adapters/fs/completionReceiptFileStore');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  PrimaryCompletionReceiptConsumer,
} = require('../../back/runtime/application/primaryCompletionReceiptConsumer');
const {
  PrimaryRunCompletionService,
  PrimaryCompletionUnauthorizedError,
  hashPrimaryCompletionToken,
} = require('../../back/runtime/application/primaryRunCompletionService');
const {
  PrimaryRunCreator,
} = require('../../back/runtime/application/primaryRunCreator');
const {
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');

const NOW = 1_750_000_000_000;
const TOKEN = 'completion_token_abcdefghijklmnopqrstuvwxyz0123456789';
let idSequence = 900;

function nextId() {
  idSequence += 1;
  return `019f70f0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
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
    ],
    logger: { info() {} },
  });
  return new LegacySequelizeRunRepository(database);
}

async function runningReference(repository) {
  const creator = new PrimaryRunCreator(repository, nextId);
  const commands = new RunCommandService(repository, nextId);
  const created = await creator.create(
    {
      projectId: 'default',
      taskId: 'legacy-cron:9',
      taskRevision: 'revision-9',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: NOW,
      actor: { type: 'user', id: 'user:1' },
    },
    'local_process',
  );
  const dispatching = await commands.transitionRun({
    runId: created.run.id,
    to: 'dispatching',
    expectedVersion: created.run.version,
    atMs: NOW + 1,
    actor: { type: 'scheduler' },
  });
  const starting = await commands.transitionRunAttempt({
    runId: created.run.id,
    attemptId: created.attempt.id,
    to: 'starting',
    expectedRunVersion: dispatching.run.version,
    atMs: NOW + 2,
    callbackTokenHash: hashPrimaryCompletionToken(TOKEN),
    actor: { type: 'worker', id: 'local_process' },
  });
  const attempt = await commands.transitionRunAttempt({
    runId: created.run.id,
    attemptId: created.attempt.id,
    to: 'running',
    expectedRunVersion: starting.run.version,
    atMs: NOW + 3,
    executorHandle: 'ql3lp1.test-handle',
    actor: { type: 'executor', id: 'local_process' },
  });
  const run = await commands.transitionRun({
    runId: created.run.id,
    to: 'running',
    expectedVersion: attempt.run.version,
    atMs: NOW + 3,
    actor: { type: 'executor', id: 'local_process' },
  });
  return { run: run.run, attempt: attempt.attempt, commands };
}

function successfulResult() {
  return {
    outcome: 'succeeded',
    startedAtMs: NOW + 3,
    finishedAtMs: NOW + 10,
    exitCode: 0,
  };
}

function receipt(reference) {
  return {
    schemaVersion: 1,
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: NOW + 3,
    finishedAtMs: NOW + 10,
    exitCode: 0,
  };
}

class FailAfterWorkRepository {
  fail = true;

  constructor(delegate) {
    this.delegate = delegate;
  }

  findRunById(runId) {
    return this.delegate.findRunById(runId);
  }

  findAttemptById(attemptId) {
    return this.delegate.findAttemptById(attemptId);
  }

  listEvents(runId, options) {
    return this.delegate.listEvents(runId, options);
  }

  listCancellationRequested(options) {
    return this.delegate.listCancellationRequested(options);
  }

  transaction(work) {
    return this.delegate.transaction(async (transaction) => {
      const result = await work(transaction);
      if (this.fail) {
        this.fail = false;
        throw new Error('simulated crash before commit');
      }
      return result;
    });
  }
}

class FailFirstRemoveStore {
  fail = true;

  constructor(delegate) {
    this.delegate = delegate;
  }

  publish(value) {
    return this.delegate.publish(value);
  }

  read(attemptId) {
    return this.delegate.read(attemptId);
  }

  async remove(attemptId) {
    if (this.fail) {
      this.fail = false;
      throw new Error('simulated crash before receipt cleanup');
    }
    return this.delegate.remove(attemptId);
  }
}

async function receiptStore(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-completion-service-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new CompletionReceiptFileStore(root);
}

test('atomically applies one completion and treats an identical replay as terminal', async (t) => {
  const repository = await setup(t);
  const reference = await runningReference(repository);
  const service = new PrimaryRunCompletionService(repository, nextId);
  const command = {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    callbackSequence: 1,
    result: successfulResult(),
    source: { kind: 'receipt', token: TOKEN },
  };

  const applied = await service.complete(command);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.run.status, 'succeeded');
  assert.equal(applied.attempt.status, 'succeeded');
  assert.equal(applied.attempt.callbackSequence, 1);
  const eventsAfterApply = await repository.listEvents(reference.run.id);
  assert.doesNotMatch(JSON.stringify(eventsAfterApply), new RegExp(TOKEN));
  assert.deepEqual(
    eventsAfterApply.slice(-2).map((event) => event.type),
    ['attempt.succeeded', 'run.succeeded'],
  );

  const replay = await service.complete(command);
  assert.equal(replay.status, 'already_terminal');
  assert.equal(
    (await repository.listEvents(reference.run.id)).length,
    eventsAfterApply.length,
  );
});

test('rejects an invalid receipt token without changing durable state', async (t) => {
  const repository = await setup(t);
  const reference = await runningReference(repository);
  const service = new PrimaryRunCompletionService(repository, nextId);
  const beforeEvents = await repository.listEvents(reference.run.id);

  await assert.rejects(
    service.complete({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      callbackSequence: 1,
      result: successfulResult(),
      source: {
        kind: 'receipt',
        token: 'wrong_token_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    }),
    PrimaryCompletionUnauthorizedError,
  );
  assert.equal(
    (await repository.findRunById(reference.run.id)).status,
    'running',
  );
  assert.equal(
    (await repository.findAttemptById(reference.attempt.id)).callbackSequence,
    0,
  );
  assert.equal(
    (await repository.listEvents(reference.run.id)).length,
    beforeEvents.length,
  );
});

test('quarantines an unauthorized receipt instead of retrying it forever', async (t) => {
  const repository = await setup(t);
  const reference = await runningReference(repository);
  const store = await receiptStore(t);
  await store.publish({
    ...receipt(reference),
    token: 'wrong_token_abcdefghijklmnopqrstuvwxyz0123456789',
  });
  const quarantines = [];
  const consumer = new PrimaryCompletionReceiptConsumer(
    store,
    new PrimaryRunCompletionService(repository, nextId),
    {
      journal: {
        async markQuarantined(command) {
          quarantines.push(command);
        },
        async resolve() {
          return true;
        },
      },
      quarantineRetentionMs: 5_000,
      clock: { now: () => NOW + 20 },
    },
  );

  const result = await consumer.consume(reference.attempt.id);
  assert.equal(result.status, 'quarantined');
  assert.equal(result.cleaned, true);
  assert.match(result.quarantineRef, /^\.quarantine\//);
  assert.deepEqual(quarantines, [
    {
      attemptId: reference.attempt.id,
      quarantineRef: store.quarantineReference(reference.attempt.id),
      updatedAtMs: NOW + 20,
      purgeAfterMs: NOW + 5_020,
    },
  ]);
  assert.equal(await store.read(reference.attempt.id), undefined);
  assert.equal(
    (await repository.findRunById(reference.run.id)).status,
    'running',
  );
});

test('maps a persisted timeout request before a late successful receipt', async (t) => {
  const repository = await setup(t);
  const reference = await runningReference(repository);
  await reference.commands.requestCancellation({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    atMs: NOW + 5,
    reason: 'timeout',
    actor: { type: 'system', id: 'runtime:timeout' },
  });

  const completed = await new PrimaryRunCompletionService(
    repository,
    nextId,
  ).complete({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    callbackSequence: 1,
    result: successfulResult(),
    source: { kind: 'receipt', token: TOKEN },
  });
  assert.equal(completed.run.status, 'timed_out');
  assert.equal(completed.attempt.status, 'timed_out');
});

test('keeps a receipt when the terminal transaction crashes before commit', async (t) => {
  const repository = await setup(t);
  const reference = await runningReference(repository);
  const store = await receiptStore(t);
  await store.publish(receipt(reference));
  const failing = new PrimaryCompletionReceiptConsumer(
    store,
    new PrimaryRunCompletionService(
      new FailAfterWorkRepository(repository),
      nextId,
    ),
  );

  await assert.rejects(
    failing.consume(reference.attempt.id),
    /simulated crash before commit/,
  );
  assert.ok(await store.read(reference.attempt.id));
  assert.equal(
    (await repository.findRunById(reference.run.id)).status,
    'running',
  );

  const recovered = await new PrimaryCompletionReceiptConsumer(
    store,
    new PrimaryRunCompletionService(repository, nextId),
  ).consume(reference.attempt.id);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.cleaned, true);
  assert.equal(await store.read(reference.attempt.id), undefined);
  assert.equal(
    (await repository.listEvents(reference.run.id)).filter(
      (event) => event.type === 'run.succeeded',
    ).length,
    1,
  );
});

test('replays terminal state and cleans a receipt after cleanup crashes', async (t) => {
  const repository = await setup(t);
  const reference = await runningReference(repository);
  const fileStore = await receiptStore(t);
  const store = new FailFirstRemoveStore(fileStore);
  await store.publish(receipt(reference));
  const consumer = new PrimaryCompletionReceiptConsumer(
    store,
    new PrimaryRunCompletionService(repository, nextId),
  );

  await assert.rejects(
    consumer.consume(reference.attempt.id),
    /simulated crash before receipt cleanup/,
  );
  assert.equal(
    (await repository.findRunById(reference.run.id)).status,
    'succeeded',
  );
  assert.ok(await store.read(reference.attempt.id));
  const eventCount = (await repository.listEvents(reference.run.id)).length;

  const replay = await consumer.consume(reference.attempt.id);
  assert.equal(replay.status, 'already_terminal');
  assert.equal(replay.cleaned, true);
  assert.equal(await store.read(reference.attempt.id), undefined);
  assert.equal(
    (await repository.listEvents(reference.run.id)).length,
    eventCount,
  );
});
