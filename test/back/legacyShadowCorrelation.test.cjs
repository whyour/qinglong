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
  LegacyShadowRunCorrelator,
} = require('../../back/runtime/application/legacyShadowRunCorrelator');
const {
  LegacyShadowRunWriter,
} = require('../../back/runtime/application/legacyShadowRunWriter');

const databases = [];
let idSequence = 600;
let timeSequence = 1_750_000_100_000;

function nextId() {
  idSequence += 1;
  return `019f70f0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function nextTime() {
  timeSequence += 10;
  return timeSequence;
}

async function createRepository() {
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
  return new LegacySequelizeRunRepository(database);
}

async function createActive(writer, overrides = {}) {
  const atMs = nextTime();
  const reference = await writer.accept({
    origin: 'manual',
    projectId: 'default',
    taskId: 'legacy-cron:15',
    taskRevision: 'sha256:revision',
    legacyCronId: 15,
    triggerType: 'manual',
    acceptedAtMs: atMs,
    ...overrides,
  });
  await writer.spawned(reference, {
    atMs: atMs + 1,
    ...(overrides.pid === undefined ? {} : { pid: overrides.pid }),
    ...(overrides.logArtifactId === undefined
      ? {}
      : { logArtifactId: overrides.logArtifactId }),
  });
  await writer.running(reference, atMs + 2);
  return { reference, atMs };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('lists bounded active candidates by legacy cron and origin', async () => {
  const repository = await createRepository();
  const writer = new LegacyShadowRunWriter(repository, nextId);
  await createActive(writer, { pid: 11, logArtifactId: 'log-a' });
  await createActive(writer, { pid: 22, logArtifactId: 'log-b' });
  await createActive(writer, {
    origin: 'scheduled_node',
    pid: 33,
    logArtifactId: 'log-c',
  });

  const manual = await repository.listActiveByLegacyCron({
    legacyCronId: 15,
    origins: ['manual'],
  });
  assert.equal(manual.candidates.length, 2);
  assert.equal(manual.truncated, false);
  assert.deepEqual(
    new Set(manual.candidates.map((candidate) => candidate.pid)),
    new Set([11, 22]),
  );

  const bounded = await repository.listActiveByLegacyCron({
    legacyCronId: 15,
    origins: ['manual', 'scheduled_node'],
    limit: 1,
  });
  assert.equal(bounded.candidates.length, 1);
  assert.equal(bounded.truncated, true);
  await assert.rejects(
    repository.listActiveByLegacyCron({
      legacyCronId: 0,
      origins: ['manual'],
    }),
    RangeError,
  );
});

test('correlates callbacks by log before pid and refuses ambiguity', async () => {
  const repository = await createRepository();
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const first = await createActive(writer, {
    pid: 41,
    logArtifactId: 'log-first',
  });
  const second = await createActive(writer, {
    pid: 42,
    logArtifactId: 'log-second',
  });
  const failures = [];
  const correlator = new LegacyShadowRunCorrelator(repository, writer, {
    failure: (failure) => failures.push(failure),
  });

  const ambiguous = await correlator.callback(
    {
      legacyCronId: 15,
      atMs: nextTime(),
      phase: 'running',
    },
    ['manual'],
  );
  assert.equal(ambiguous.matched, 0);
  assert.equal(failures[0].reason, 'ambiguous');

  const conflicting = await correlator.callback(
    {
      legacyCronId: 15,
      pid: 41,
      logArtifactId: 'log-second',
      atMs: nextTime(),
      phase: 'finished',
      exitCode: 0,
    },
    ['manual'],
  );
  assert.equal(conflicting.matched, 0);
  assert.equal(failures[1].reason, 'ambiguous');

  const finished = await correlator.callback(
    {
      legacyCronId: 15,
      pid: 999,
      logArtifactId: 'log-second',
      atMs: nextTime(),
      phase: 'finished',
      exitCode: 0,
    },
    ['manual'],
  );
  assert.equal(finished.matched, 1);
  assert.equal(
    (await repository.findRunById(second.reference.runId)).status,
    'succeeded',
  );
  assert.equal(
    (await repository.findRunById(first.reference.runId)).status,
    'running',
  );
});

test('cancels one exact candidate or every active candidate', async () => {
  const repository = await createRepository();
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const first = await createActive(writer, { pid: 51 });
  const second = await createActive(writer, { pid: 52 });
  const failures = [];
  const correlator = new LegacyShadowRunCorrelator(repository, writer, {
    failure: (failure) => failures.push(failure),
  });

  const one = await correlator.cancel(
    {
      legacyCronId: 15,
      pid: 51,
      atMs: nextTime(),
      scope: 'one',
      reason: 'user',
    },
    ['manual'],
  );
  assert.equal(one.matched, 1);
  assert.equal(
    (await repository.findRunById(first.reference.runId)).status,
    'cancelled',
  );
  assert.equal(
    (await repository.findRunById(second.reference.runId)).status,
    'running',
  );

  const all = await correlator.cancel(
    {
      legacyCronId: 15,
      atMs: nextTime(),
      scope: 'all',
      reason: 'policy',
    },
    ['manual'],
  );
  assert.equal(all.matched, 1);
  assert.equal(
    (await repository.findRunById(second.reference.runId)).status,
    'cancelled',
  );
  assert.deepEqual(failures, []);
});

test('recovers an out-of-order finish and ignores duplicate terminal callbacks', async () => {
  const repository = await createRepository();
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const atMs = nextTime();
  const reference = await writer.accept({
    origin: 'manual',
    projectId: 'default',
    taskId: 'legacy-cron:16',
    taskRevision: 'sha256:revision',
    legacyCronId: 16,
    triggerType: 'manual',
    acceptedAtMs: atMs,
  });
  const failures = [];
  const correlator = new LegacyShadowRunCorrelator(repository, writer, {
    failure: (failure) => failures.push(failure),
  });

  const first = await correlator.callback(
    {
      legacyCronId: 16,
      pid: 160,
      logArtifactId: 'log-16',
      atMs: atMs + 10,
      phase: 'finished',
      exitCode: 0,
    },
    ['manual'],
  );
  assert.equal(first.matched, 1);
  assert.equal(
    (await repository.findRunById(reference.runId)).status,
    'succeeded',
  );
  const events = await repository.listEvents(reference.runId);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'run.created',
      'run.queued',
      'run.dispatching',
      'attempt.starting',
      'attempt.running',
      'run.running',
      'attempt.succeeded',
      'run.succeeded',
    ],
  );

  const duplicate = await correlator.callback(
    {
      legacyCronId: 16,
      pid: 160,
      logArtifactId: 'log-16',
      atMs: atMs + 20,
      phase: 'finished',
      exitCode: 0,
    },
    ['manual'],
  );
  assert.equal(duplicate.matched, 0);
  assert.equal(failures[0].reason, 'unmatched');
  assert.equal((await repository.listEvents(reference.runId)).length, 8);
});

test('keeps cancellation terminal when a late successful callback arrives', async () => {
  const repository = await createRepository();
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const active = await createActive(writer, { pid: 170 });
  const failures = [];
  const correlator = new LegacyShadowRunCorrelator(repository, writer, {
    failure: (failure) => failures.push(failure),
  });

  await correlator.cancel(
    {
      legacyCronId: 15,
      pid: 170,
      atMs: nextTime(),
      scope: 'one',
      reason: 'user',
    },
    ['manual'],
  );
  const eventCount = (await repository.listEvents(active.reference.runId))
    .length;
  const late = await correlator.callback(
    {
      legacyCronId: 15,
      pid: 170,
      atMs: nextTime(),
      phase: 'finished',
      exitCode: 0,
    },
    ['manual'],
  );

  assert.equal(late.matched, 0);
  assert.equal(
    (await repository.findRunById(active.reference.runId)).status,
    'cancelled',
  );
  assert.equal(
    (await repository.listEvents(active.reference.runId)).length,
    eventCount,
  );
  assert.equal(failures[0].reason, 'unmatched');
});

test('continues cancel-all correlation after an individual shadow write fails', async () => {
  const writes = [];
  const failures = [];
  const locator = {
    async listActiveByLegacyCron() {
      return {
        truncated: false,
        candidates: [
          {
            runId: 'run-a',
            attemptId: 'attempt-a',
            origin: 'manual',
            runStatus: 'running',
            attemptStatus: 'running',
            createdAtMs: 1,
          },
          {
            runId: 'run-b',
            attemptId: 'attempt-b',
            origin: 'manual',
            runStatus: 'running',
            attemptStatus: 'running',
            createdAtMs: 2,
          },
        ],
      };
    },
  };
  const writer = {
    async cancelled(reference) {
      writes.push(reference.runId);
      if (reference.runId === 'run-a') throw new Error('write failed');
    },
  };
  const correlator = new LegacyShadowRunCorrelator(locator, writer, {
    failure: (failure) => failures.push(failure),
  });

  const result = await correlator.cancel(
    {
      legacyCronId: 15,
      atMs: 4,
      scope: 'all',
      reason: 'user',
    },
    ['manual'],
  );
  assert.deepEqual(writes, ['run-a', 'run-b']);
  assert.equal(result.matched, 1);
  assert.equal(failures[0].reason, 'write_failed');
});
