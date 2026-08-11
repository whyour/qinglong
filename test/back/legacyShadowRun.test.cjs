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
  LegacyShadowRunObserver,
} = require('../../back/runtime/application/legacyShadowRunObserver');
const {
  LegacyShadowRunWriter,
} = require('../../back/runtime/application/legacyShadowRunWriter');
const {
  RuntimeRolloutPolicy,
} = require('../../back/runtime/domain/runtimeRollout');

const databases = [];
const ACCEPTED_AT_MS = 1_750_000_000_000;
let idSequence = 300;

function nextId() {
  idSequence += 1;
  return `019f70e0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
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

function acceptedFact(overrides = {}) {
  return {
    origin: 'manual',
    projectId: 'default',
    taskId: 'legacy-cron:7',
    taskRevision: 'sha256:revision',
    taskName: 'shadow test',
    legacyCronId: 7,
    triggerType: 'manual',
    triggeredBy: 'legacy:manual',
    acceptedAtMs: ACCEPTED_AT_MS,
    ...overrides,
  };
}

function policy(mode = 'shadow') {
  return new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: { manual: mode },
    allowLegacyFallbackBeforeStart: false,
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('persists an accepted legacy execution as one queued shadow aggregate', async () => {
  const repository = await createRepository();
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const reference = await writer.accept(acceptedFact());
  const run = await repository.findRunById(reference.runId);
  const attempt = await repository.findAttemptById(reference.attemptId);
  const events = await repository.listEvents(reference.runId);

  assert.equal(run.status, 'queued');
  assert.equal(run.version, 2);
  assert.equal(run.eventSequence, 2);
  assert.equal(run.executionOwner, 'legacy');
  assert.equal(attempt.status, 'claimed');
  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, 'run.created'],
      [2, 'run.queued'],
    ],
  );
  assert.equal(
    events.every((event) => event.payload.shadow === true),
    true,
  );
});

test('serializes a successful observed process lifecycle without starting it', async () => {
  const repository = await createRepository();
  const references = [];
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const originalAccept = writer.accept.bind(writer);
  writer.accept = async (fact) => {
    const reference = await originalAccept(fact);
    references.push(reference);
    return reference;
  };
  const failures = [];
  const observer = new LegacyShadowRunObserver(policy(), writer, {
    failure: (failure) => failures.push(failure),
  });
  const observation = observer.begin(acceptedFact());
  observation.spawned({
    atMs: ACCEPTED_AT_MS + 1,
    pid: 4242,
    executorHandle: 'legacy-local:4242',
    logArtifactId: 'legacy-log:1234567890123456789012345',
  });
  observation.running({ atMs: ACCEPTED_AT_MS + 1 });
  observation.exited({ atMs: ACCEPTED_AT_MS + 2, exitCode: 0 });
  await observation.settled();

  assert.deepEqual(failures, []);
  const reference = references[0];
  const run = await repository.findRunById(reference.runId);
  const attempt = await repository.findAttemptById(reference.attemptId);
  const events = await repository.listEvents(reference.runId);

  assert.equal(run.status, 'succeeded');
  assert.equal(run.version, 8);
  assert.equal(run.eventSequence, 8);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.pid, 4242);
  assert.equal(attempt.executorHandle, 'legacy-local:4242');
  assert.equal(attempt.logArtifactId, 'legacy-log:1234567890123456789012345');
  assert.equal(attempt.startedAtMs, ACCEPTED_AT_MS + 1);
  assert.equal(attempt.finishedAtMs, ACCEPTED_AT_MS + 2);
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
});

test('maps non-zero exits and start errors to stable failed terminal states', async () => {
  for (const scenario of ['exit', 'start_error']) {
    const repository = await createRepository();
    const references = [];
    const writer = new LegacyShadowRunWriter(repository, nextId);
    const originalAccept = writer.accept.bind(writer);
    writer.accept = async (fact) => {
      const reference = await originalAccept(fact);
      references.push(reference);
      return reference;
    };
    const observer = new LegacyShadowRunObserver(policy(), writer, {
      failure() {},
    });
    const observation = observer.begin(
      acceptedFact({ taskId: `case:${scenario}` }),
    );
    if (scenario === 'exit') {
      observation.spawned({ atMs: ACCEPTED_AT_MS + 1, pid: 12 });
      observation.running({ atMs: ACCEPTED_AT_MS + 1 });
      observation.exited({ atMs: ACCEPTED_AT_MS + 2, exitCode: 9 });
    } else {
      observation.startFailed({
        atMs: ACCEPTED_AT_MS + 1,
        errorCode: 'LEGACY_PROCESS_ERROR',
      });
    }
    await observation.settled();

    const reference = references[0];
    const run = await repository.findRunById(reference.runId);
    const attempt = await repository.findAttemptById(reference.attemptId);
    assert.equal(run.status, 'failed');
    assert.equal(attempt.status, 'failed');
    if (scenario === 'exit') {
      assert.equal(run.errorCode, 'LEGACY_EXIT_NON_ZERO');
      assert.equal(attempt.exitCode, 9);
    } else {
      assert.equal(run.errorCode, 'LEGACY_PROCESS_ERROR');
    }
  }
});

test('is default-off, fail-open, and rejects primary ownership', async () => {
  let writes = 0;
  const failures = [];
  const writer = {
    async accept() {
      writes += 1;
      const error = new Error('database unavailable');
      error.code = 'SQLITE_BUSY';
      throw error;
    },
  };
  const off = new LegacyShadowRunObserver(policy('off'), writer, {
    failure: (failure) => failures.push(failure),
  });
  const noOp = off.begin(acceptedFact());
  noOp.spawned({ atMs: ACCEPTED_AT_MS + 1 });
  await noOp.settled();
  assert.equal(writes, 0);

  const shadow = new LegacyShadowRunObserver(policy(), writer, {
    failure: (failure) => failures.push(failure),
  });
  const failed = shadow.begin(acceptedFact());
  failed.spawned({ atMs: ACCEPTED_AT_MS + 1 });
  failed.exited({ atMs: ACCEPTED_AT_MS + 2, exitCode: 0 });
  await failed.settled();
  assert.equal(writes, 1);
  assert.deepEqual(failures, [
    {
      origin: 'manual',
      operation: 'accept',
      errorCode: 'SQLITE_BUSY',
    },
  ]);

  const primary = new LegacyShadowRunObserver(policy('primary'), writer, {
    failure() {},
  });
  assert.throws(() => primary.begin(acceptedFact()), /primary execution/);
});

test('reports an individual shadow write failure and continues later facts', async () => {
  const calls = [];
  const failures = [];
  const writer = {
    async accept() {
      calls.push('accept');
      return { runId: 'run-1', attemptId: 'attempt-1' };
    },
    async spawned() {
      calls.push('spawned');
      const error = new Error('first write lost');
      error.code = 'RUN_VERSION_CONFLICT';
      throw error;
    },
    async running() {
      calls.push('running');
    },
    async exited() {
      calls.push('exited');
    },
  };
  const observer = new LegacyShadowRunObserver(policy(), writer, {
    failure: (failure) => failures.push(failure),
  });
  const observation = observer.begin(acceptedFact());
  observation.spawned({ atMs: ACCEPTED_AT_MS + 1 });
  observation.running({ atMs: ACCEPTED_AT_MS + 2 });
  observation.exited({ atMs: ACCEPTED_AT_MS + 3, exitCode: 0 });
  await observation.settled();

  assert.deepEqual(calls, ['accept', 'spawned', 'running', 'exited']);
  assert.deepEqual(failures, [
    {
      origin: 'manual',
      operation: 'spawned',
      errorCode: 'RUN_VERSION_CONFLICT',
      runId: 'run-1',
      attemptId: 'attempt-1',
    },
  ]);
});
