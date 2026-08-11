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
  runRetryPolicyMigration,
} = require('../../back/migrations/0011-run-retry-policy');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunLostRetrySource,
} = require('../../back/runtime/adapters/legacy-sequelize/runLostRetrySource');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  PrimaryRunCreator,
} = require('../../back/runtime/application/primaryRunCreator');
const {
  RunLostRetryScanner,
} = require('../../back/runtime/application/runLostRetryScanner');
const {
  RunLostRetryService,
} = require('../../back/runtime/application/runLostRetryService');
const {
  requestRunCancellation,
  transitionRun,
  transitionRunAttempt,
} = require('../../back/runtime/domain/runStateMachine');

const START = 1_762_000_000_000;
let idSequence = 0;

function nextId() {
  idSequence += 1;
  return `019f7500-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function event(run, draft, attemptId, atMs, dedupeKey = nextId()) {
  return {
    id: nextId(),
    runId: run.id,
    sequence: draft.sequence,
    type: draft.type,
    dedupeKey,
    actorType: 'reconciler',
    attemptId,
    payload: draft.payload,
    createdAtMs: atMs,
  };
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
      runRetryPolicyMigration,
    ],
    logger: { info() {} },
  });
  let nowMs = START;
  const repository = new LegacySequelizeRunRepository(database);
  const service = new RunLostRetryService(repository, {
    clock: { now: () => nowMs },
    createId: nextId,
  });
  return {
    database,
    repository,
    service,
    setNow(value) {
      nowMs = value;
    },
    getNow() {
      return nowMs;
    },
  };
}

async function createRun(context, retryPolicy) {
  return new PrimaryRunCreator(context.repository, nextId).create(
    {
      projectId: 'default',
      taskId: `retry-task-${idSequence}`,
      taskRevision: 'revision-1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: context.getNow(),
      actor: { type: 'user', id: 'operator' },
      ...(retryPolicy === undefined ? {} : { retryPolicy }),
    },
    'remote_worker',
  );
}

async function markLost(context, reference) {
  const atMs = context.getNow();
  return context.repository.transaction(async (transaction) => {
    const run = await transaction.findRunById(reference.run.id);
    const attempt = await transaction.findLatestAttemptByRunId(run.id);
    const dispatching = transitionRun(run, {
      to: 'dispatching',
      expectedVersion: run.version,
      atMs,
    });
    assert.equal(
      await transaction.compareAndSetRun(dispatching.run, run.version),
      true,
    );
    await transaction.appendEvent(
      event(dispatching.run, dispatching.event, attempt.id, atMs),
    );
    const attemptLost = transitionRunAttempt(dispatching.run, attempt, {
      to: 'lost',
      expectedRunVersion: dispatching.run.version,
      atMs,
      errorCode: 'TEST_EXECUTION_LOST',
      errorSummary: 'test lost execution',
    });
    assert.equal(
      await transaction.compareAndSetRun(
        attemptLost.run,
        dispatching.run.version,
      ),
      true,
    );
    assert.equal(
      await transaction.compareAndSetAttempt(attemptLost.attempt, {
        status: attempt.status,
        callbackSequence: attempt.callbackSequence,
      }),
      true,
    );
    await transaction.appendEvent(
      event(attemptLost.run, attemptLost.event, attempt.id, atMs),
    );
    const runLost = transitionRun(attemptLost.run, {
      to: 'lost',
      expectedVersion: attemptLost.run.version,
      atMs,
      errorCode: 'TEST_EXECUTION_LOST',
      errorSummary: 'test lost execution',
    });
    assert.equal(
      await transaction.compareAndSetRun(runLost.run, attemptLost.run.version),
      true,
    );
    await transaction.appendEvent(
      event(runLost.run, runLost.event, attempt.id, atMs),
    );
    return { run: runLost.run, attempt: attemptLost.attempt };
  });
}

const safePolicy = {
  maxAttempts: 3,
  retryOnLost: true,
  safety: 'idempotent',
  backoffBaseMs: 100,
  backoffMaxMs: 1_000,
};

test('schedules lost recovery, then atomically creates a fresh Attempt N+1', async (t) => {
  const context = await setup(t);
  const first = await createRun(context, safePolicy);
  await markLost(context, first);

  const scheduled = await context.service.reconcile(first.run.id);
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.run.status, 'retry_wait');
  assert.equal(scheduled.policy.nextAttemptAtMs, START + 100);
  assert.equal(
    (await context.service.reconcile(first.run.id)).status,
    'not_due',
  );

  context.setNow(START + 100);
  const requeued = await context.service.reconcile(first.run.id);
  assert.equal(requeued.status, 'requeued');
  assert.equal(requeued.run.status, 'queued');
  assert.equal(requeued.attempt.attempt, 2);
  assert.equal(requeued.attempt.status, 'claimed');
  assert.equal(requeued.policy.nextAttemptAtMs, undefined);
  assert.deepEqual(
    requeued.events.map((item) => item.type),
    ['run.queued', 'attempt.claimed'],
  );
  assert.equal(
    (await context.service.reconcile(first.run.id)).status,
    'not_eligible',
  );
  assert.equal(
    (await context.repository.findLatestAttemptByRunId(first.run.id)).attempt,
    2,
  );
});

test('fails closed when retry is absent, unsafe, or exhausted', async (t) => {
  const context = await setup(t);
  const withoutPolicy = await createRun(context);
  await markLost(context, withoutPolicy);
  const disabled = await context.service.reconcile(withoutPolicy.run.id);
  assert.equal(disabled.status, 'failed_disabled');
  assert.equal(disabled.run.status, 'failed');
  assert.equal(disabled.run.errorCode, 'RUN_LOST_RETRY_DISABLED');

  await assert.rejects(
    createRun(context, {
      ...safePolicy,
      safety: 'unknown',
    }),
    /requires idempotent or deduplicated safety/,
  );

  const limited = await createRun(context, { ...safePolicy, maxAttempts: 2 });
  await markLost(context, limited);
  await context.service.reconcile(limited.run.id);
  context.setNow(context.getNow() + 100);
  const second = await context.service.reconcile(limited.run.id);
  await markLost(context, second);
  const exhausted = await context.service.reconcile(limited.run.id);
  assert.equal(exhausted.status, 'failed_exhausted');
  assert.equal(exhausted.run.errorCode, 'RUN_LOST_RETRY_EXHAUSTED');
});

test('cancellation wins over a scheduled replacement Attempt', async (t) => {
  const context = await setup(t);
  const reference = await createRun(context, safePolicy);
  await markLost(context, reference);
  const scheduled = await context.service.reconcile(reference.run.id);
  await context.repository.transaction(async (transaction) => {
    const run = await transaction.findRunById(reference.run.id);
    const cancellation = requestRunCancellation(run, {
      expectedVersion: run.version,
      atMs: context.getNow(),
      reason: 'user',
    });
    assert.equal(cancellation.status, 'accepted');
    assert.equal(
      await transaction.compareAndSetRun(cancellation.run, run.version),
      true,
    );
    await transaction.appendEvent(
      event(
        cancellation.run,
        cancellation.event,
        scheduled.attempt.id,
        context.getNow(),
      ),
    );
  });
  context.setNow(START + 100);
  const cancelled = await context.service.reconcile(reference.run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.policy.nextAttemptAtMs, undefined);
  assert.equal(
    (await context.repository.findLatestAttemptByRunId(reference.run.id))
      .attempt,
    1,
  );
});

test('rolls back Run and policy when fresh Attempt insertion fails', async (t) => {
  const context = await setup(t);
  const reference = await createRun(context, safePolicy);
  await markLost(context, reference);
  const scheduled = await context.service.reconcile(reference.run.id);
  context.setNow(START + 100);
  const failingRepository = {
    transaction(work) {
      return context.repository.transaction((transaction) =>
        work(
          new Proxy(transaction, {
            get(target, property) {
              if (property === 'insertAttempt') {
                return async () => {
                  throw new Error('simulated attempt insert failure');
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      );
    },
  };
  const service = new RunLostRetryService(failingRepository, {
    clock: { now: () => context.getNow() },
    createId: nextId,
  });
  await assert.rejects(
    service.reconcile(reference.run.id),
    /simulated attempt insert failure/,
  );
  const run = await context.repository.findRunById(reference.run.id);
  const policy = await context.repository.findRetryPolicyByRunId(
    reference.run.id,
  );
  assert.equal(run.status, 'retry_wait');
  assert.equal(run.version, scheduled.run.version);
  assert.equal(policy.version, scheduled.policy.version);
  assert.equal(policy.nextAttemptAtMs, START + 100);
  assert.equal(
    (await context.repository.findLatestAttemptByRunId(reference.run.id))
      .attempt,
    1,
  );
});

test('serializes two control-plane connections racing to create Attempt N+1', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-lost-retry-race-'));
  const storage = path.join(root, 'database.sqlite');
  const databases = [
    new Sequelize({ dialect: 'sqlite', storage, logging: false }),
    new Sequelize({ dialect: 'sqlite', storage, logging: false }),
  ];
  t.after(async () => {
    await Promise.all(databases.map((database) => database.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await runMigrations({
    database: databases[0],
    migrationModel: defineSchemaMigrationModel(databases[0]),
    migrations: [
      runSchemaMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
      runRetryPolicyMigration,
    ],
    logger: { info() {} },
  });
  for (const database of databases) {
    await database.query('PRAGMA journal_mode=WAL');
    await database.query('PRAGMA busy_timeout=1000');
  }
  let nowMs = START;
  const repositories = databases.map(
    (database) => new LegacySequelizeRunRepository(database),
  );
  const context = {
    repository: repositories[0],
    getNow: () => nowMs,
  };
  const reference = await createRun(context, safePolicy);
  await markLost(context, reference);
  const services = repositories.map(
    (repository) =>
      new RunLostRetryService(repository, {
        clock: { now: () => nowMs },
        createId: nextId,
      }),
  );
  await services[0].reconcile(reference.run.id);
  nowMs = START + 100;
  const results = await Promise.all(
    services.map((service) => service.reconcile(reference.run.id)),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [
    'not_eligible',
    'requeued',
  ]);
  assert.equal(
    (await repositories[0].findLatestAttemptByRunId(reference.run.id)).attempt,
    2,
  );
  const events = await repositories[0].listEvents(reference.run.id);
  assert.equal(
    events.filter((item) => item.type === 'attempt.claimed').length,
    1,
  );
});

test('SQLite source returns only lost and due retry_wait work in bounded order', async (t) => {
  const context = await setup(t);
  const lost = await createRun(context, safePolicy);
  await markLost(context, lost);

  const due = await createRun(context, safePolicy);
  await markLost(context, due);
  await context.service.reconcile(due.run.id);

  const future = await createRun(context, {
    ...safePolicy,
    backoffBaseMs: 10_000,
    backoffMaxMs: 10_000,
  });
  await markLost(context, future);
  await context.service.reconcile(future.run.id);

  context.setNow(START + 100);
  const source = new LegacySequelizeRunLostRetrySource(context.database);
  const candidates = await source.listCandidates({
    observedAtMs: context.getNow(),
    limit: 16,
  });
  assert.deepEqual(
    candidates.map(({ runId, phase }) => [runId, phase]),
    [
      [lost.run.id, 'lost'],
      [due.run.id, 'retry_wait'],
    ],
  );
  await assert.rejects(
    source.listCandidates({ observedAtMs: context.getNow(), limit: 65 }),
    /limit must be between/,
  );
});

test('bounded scanner isolates a poison candidate and continues the page', async () => {
  const calls = [];
  const scanner = new RunLostRetryScanner(
    {
      async listCandidates() {
        return [
          { runId: 'run-a', phase: 'lost', availableAtMs: 0 },
          { runId: 'run-b', phase: 'lost', availableAtMs: 0 },
          { runId: 'run-c', phase: 'retry_wait', availableAtMs: START },
        ];
      },
    },
    {
      async reconcile(runId) {
        calls.push(runId);
        if (runId === 'run-b') throw new Error('poison');
        return { status: runId === 'run-a' ? 'scheduled' : 'requeued' };
      },
    },
    { clock: { now: () => START } },
  );
  const summary = await scanner.scan({ limit: 3 });
  assert.deepEqual(calls, ['run-a', 'run-b', 'run-c']);
  assert.equal(summary.failed, 1);
  assert.equal(summary.counts.scheduled, 1);
  assert.equal(summary.counts.requeued, 1);
  assert.equal(summary.truncated, true);
});
