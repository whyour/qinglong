require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { DataTypes, Sequelize } = require('sequelize');
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
  LegacySequelizeShadowStartupRecoverySource,
} = require('../../back/runtime/adapters/legacy-sequelize/legacyShadowStartupRecoverySource');
const {
  LegacyShadowRunWriter,
} = require('../../back/runtime/application/legacyShadowRunWriter');
const {
  LegacyShadowStartupReconciler,
  LegacyShadowStartupSupervisor,
} = require('../../back/runtime/application/legacyShadowStartupReconciler');
const {
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');
const {
  createLegacyLogArtifactId,
} = require('../../back/runtime/compatibility/legacyTaskRevision');

const databases = [];
let idSequence = 1_000;
let timeSequence = 1_750_001_000_000;

function nextId() {
  idSequence += 1;
  return `019f7200-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function nextTime() {
  timeSequence += 100;
  return timeSequence;
}

async function createStack() {
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
  await database.getQueryInterface().createTable('RunningInstances', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    cron_id: { type: DataTypes.INTEGER, allowNull: false },
    pid: { type: DataTypes.INTEGER, allowNull: true },
    log_path: { type: DataTypes.STRING, allowNull: true },
    started_at: { type: DataTypes.INTEGER, allowNull: false },
    finished_at: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.INTEGER, allowNull: false },
    exit_code: { type: DataTypes.INTEGER, allowNull: true },
  });
  databases.push(database);
  const repository = new LegacySequelizeRunRepository(database);
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const source = new LegacySequelizeShadowStartupRecoverySource(
    database,
    createLegacyLogArtifactId,
  );
  const reconciler = new LegacyShadowStartupReconciler(
    repository,
    source,
    writer,
    { clock: { now: () => nextTime() }, createEventId: nextId },
  );
  return { database, repository, writer, source, reconciler };
}

async function activeShadow(writer, overrides = {}) {
  const acceptedAtMs = nextTime();
  const origin = overrides.origin ?? 'manual';
  const reference = await writer.accept({
    origin,
    projectId: 'default',
    taskId: `legacy-cron:${overrides.legacyCronId ?? 15}`,
    taskRevision: 'sha256:startup-reconciliation',
    legacyCronId: overrides.legacyCronId ?? 15,
    triggerType: origin,
    acceptedAtMs,
  });
  if (overrides.queuedOnly) return { reference, acceptedAtMs };
  await writer.spawned(reference, {
    atMs: acceptedAtMs + 1,
    ...(overrides.pid === undefined ? {} : { pid: overrides.pid }),
    ...(overrides.logPath === undefined
      ? {}
      : { logArtifactId: createLegacyLogArtifactId(overrides.logPath) }),
  });
  await writer.running(reference, acceptedAtMs + 2);
  return { reference, acceptedAtMs };
}

async function insertInstance(database, values) {
  await database.getQueryInterface().bulkInsert('RunningInstances', [
    {
      cron_id: 15,
      pid: null,
      log_path: null,
      started_at: 1_750_001_000,
      finished_at: null,
      status: 0,
      exit_code: null,
      ...values,
    },
  ]);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('completes an active Shadow Run from unique terminal RunningInstance evidence', async () => {
  const { database, repository, writer, reconciler } = await createStack();
  const logPath = 'cron/2026-08-18-01.log';
  const { reference } = await activeShadow(writer, {
    pid: 4101,
    logPath,
  });
  await insertInstance(database, {
    pid: 4101,
    log_path: logPath,
    finished_at: 1_750_001_010,
    status: 1,
    exit_code: 0,
  });

  const summary = await reconciler.reconcileBatch({ origins: ['manual'] });

  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(
    (await repository.findRunById(reference.runId)).status,
    'succeeded',
  );
  assert.equal(
    (await repository.findAttemptById(reference.attemptId)).status,
    'succeeded',
  );
});

test('maps an explicitly finished stopped instance to reconciled cancellation', async () => {
  const { database, repository, writer, reconciler } = await createStack();
  const { reference } = await activeShadow(writer, { pid: 4151 });
  await insertInstance(database, {
    pid: 4151,
    finished_at: 1_750_001_011,
    status: 2,
    exit_code: 143,
  });

  const summary = await reconciler.reconcileBatch({ origins: ['manual'] });

  assert.equal(summary.cancelled, 1);
  assert.equal(
    (await repository.findRunById(reference.runId)).status,
    'cancelled',
  );
  assert.equal(
    (await repository.findAttemptById(reference.attemptId)).status,
    'cancelled',
  );
});

test('pages active Shadow candidates with a stable keyset cursor', async () => {
  const { writer, source } = await createStack();
  for (const legacyCronId of [21, 22, 23]) {
    await activeShadow(writer, { legacyCronId, queuedOnly: true });
  }

  const first = await source.listCandidates({ origins: ['manual'], limit: 2 });
  const second = await source.listCandidates({
    origins: ['manual'],
    cursor: first.nextCursor,
    limit: 2,
  });

  assert.equal(first.truncated, true);
  assert.equal(first.candidates.length, 2);
  assert.equal(second.truncated, false);
  assert.equal(second.candidates.length, 1);
  assert.equal(
    new Set(
      [...first.candidates, ...second.candidates].map(({ runId }) => runId),
    ).size,
    3,
  );
});

test('marks a worker-owned execution lost when startup reset has no terminal evidence', async () => {
  const { database, repository, writer, reconciler } = await createStack();
  const { reference } = await activeShadow(writer, { pid: 4201 });
  await insertInstance(database, {
    pid: 4201,
    status: 2,
    finished_at: null,
  });

  const summary = await reconciler.reconcileBatch({ origins: ['manual'] });

  assert.equal(summary.markedLost, 1);
  assert.equal((await repository.findRunById(reference.runId)).status, 'lost');
  assert.equal(
    (await repository.findAttemptById(reference.attemptId)).status,
    'lost',
  );
  assert.equal(
    (await repository.listEvents(reference.runId)).at(-1).actorType,
    'reconciler',
  );
});

test('abandons an accepted execution that never produced spawn evidence', async () => {
  const { repository, writer, reconciler } = await createStack();
  const { reference } = await activeShadow(writer, { queuedOnly: true });

  const summary = await reconciler.reconcileBatch({ origins: ['manual'] });

  assert.equal(summary.abandoned, 1);
  assert.equal(
    (await repository.findRunById(reference.runId)).status,
    'cancelled',
  );
  assert.equal(
    (await repository.findAttemptById(reference.attemptId)).status,
    'cancelled',
  );
});

test('keeps system-crond pending without terminal callback evidence', async () => {
  const { database, repository, writer, reconciler } = await createStack();
  const { reference } = await activeShadow(writer, {
    origin: 'scheduled_system',
    pid: 4301,
  });
  await insertInstance(database, {
    pid: 4301,
    status: 2,
    finished_at: null,
  });

  const summary = await reconciler.reconcileBatch({
    origins: ['scheduled_system'],
  });

  assert.equal(summary.pending, 1);
  assert.equal(
    (await repository.findRunById(reference.runId)).status,
    'running',
  );
  assert.equal(
    (await repository.findAttemptById(reference.attemptId)).status,
    'running',
  );
});

test('keeps a bounded per-origin outcome matrix for later ownership gates', async () => {
  const { database, writer, reconciler } = await createStack();
  await activeShadow(writer, { legacyCronId: 15, pid: 4311 });
  await activeShadow(writer, {
    origin: 'scheduled_system',
    legacyCronId: 16,
    pid: 4312,
  });
  await insertInstance(database, {
    cron_id: 15,
    pid: 4311,
    status: 2,
    finished_at: null,
  });
  await insertInstance(database, {
    cron_id: 16,
    pid: 4312,
    status: 2,
    finished_at: null,
  });

  const summary = await reconciler.reconcileBatch({
    origins: ['manual', 'scheduled_system'],
  });

  assert.deepEqual(
    summary.byOrigin.map(({ origin, scanned, markedLost, pending }) => ({
      origin,
      scanned,
      markedLost,
      pending,
    })),
    [
      { origin: 'manual', scanned: 1, markedLost: 1, pending: 0 },
      {
        origin: 'scheduled_system',
        scanned: 1,
        markedLost: 0,
        pending: 1,
      },
    ],
  );
});

test('refuses ambiguous duplicate identity evidence instead of guessing a terminal result', async () => {
  const { database, repository, writer, reconciler } = await createStack();
  const logPath = 'cron/ambiguous.log';
  const { reference } = await activeShadow(writer, {
    pid: 4351,
    logPath,
  });
  for (const pid of [4352, 4353]) {
    await insertInstance(database, {
      pid,
      log_path: logPath,
      finished_at: 1_750_001_020,
      status: 1,
      exit_code: 0,
    });
  }

  const summary = await reconciler.reconcileBatch({ origins: ['manual'] });

  assert.equal(summary.ambiguous, 1);
  assert.equal(
    (await repository.findRunById(reference.runId)).status,
    'running',
  );
  assert.equal(
    (await repository.findAttemptById(reference.attemptId)).status,
    'running',
  );
});

test('repairs a Run left active after its lost Attempt transaction committed', async () => {
  const { repository, writer, reconciler } = await createStack();
  const { reference } = await activeShadow(writer, { pid: 4401 });
  const run = await repository.findRunById(reference.runId);
  const commands = new RunCommandService(repository, nextId);
  await commands.transitionRunAttempt({
    runId: reference.runId,
    attemptId: reference.attemptId,
    to: 'lost',
    expectedRunVersion: run.version,
    atMs: nextTime(),
    errorCode: 'LEGACY_RECONCILE_OWNER_LOST',
    errorSummary: 'simulated response loss',
    actor: { type: 'reconciler' },
  });

  const summary = await reconciler.reconcileBatch({ origins: ['manual'] });

  assert.equal(summary.repaired, 1);
  assert.equal((await repository.findRunById(reference.runId)).status, 'lost');
});

test('supervisor preserves a stable cursor when its Profile budget is exhausted', async () => {
  const calls = [];
  const supervisor = new LegacyShadowStartupSupervisor({
    async reconcileBatch(options) {
      calls.push(options);
      return {
        scanned: 1,
        completed: 0,
        cancelled: 0,
        abandoned: 0,
        markedLost: 1,
        repaired: 0,
        pending: 0,
        ambiguous: 0,
        skipped: 0,
        failed: 0,
        byOrigin: [
          {
            origin: 'manual',
            scanned: 1,
            completed: 0,
            cancelled: 0,
            abandoned: 0,
            markedLost: 1,
            repaired: 0,
            pending: 0,
            ambiguous: 0,
            skipped: 0,
            failed: 0,
          },
        ],
        truncated: true,
        nextCursor: { createdAtMs: 10, runId: 'run-10' },
      };
    },
  });

  const summary = await supervisor.run({
    origins: ['manual'],
    pageSize: 8,
    maxPages: 1,
  });

  assert.equal(summary.stopReason, 'page_limit');
  assert.equal(summary.remaining, true);
  assert.deepEqual(summary.nextCursor, { createdAtMs: 10, runId: 'run-10' });
  assert.equal(calls[0].limit, 8);
});
