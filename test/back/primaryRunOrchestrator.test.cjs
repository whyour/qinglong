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
const {
  runRetryPolicyMigration,
} = require('../../back/migrations/0011-run-retry-policy');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  LegacySequelizePrimaryRunIdempotencyLookup,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryRunIdempotencyLookup');
const {
  PrimaryRunDuplicateRequestError,
  PrimaryRunIdempotencyUnavailableError,
  PrimaryRunLaunchError,
  PrimaryRunNotActiveError,
  PrimaryRunOrchestrator,
  PrimaryClaimedRunRejectedError,
  PrimaryRunRetryPolicyAuthorityError,
} = require('../../back/runtime/application/primaryRunOrchestrator');
const {
  InvalidRunRetryPolicyError,
} = require('../../back/runtime/domain/runRetryPolicy');
const {
  PrimaryRunCreator,
} = require('../../back/runtime/application/primaryRunCreator');
const {
  RunLostRetryService,
} = require('../../back/runtime/application/runLostRetryService');
const {
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');
const {
  PrimaryRunCompletionService,
  hashPrimaryCompletionToken,
} = require('../../back/runtime/application/primaryRunCompletionService');

const databases = [];
const BASE_TIME = 1_750_000_000_000;
let idSequence = 500;

function nextId() {
  idSequence += 1;
  return `019f70e0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createRepository() {
  return (await createRepositoryWithDatabase()).repository;
}

async function createRepositoryWithDatabase() {
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
      runRetryPolicyMigration,
    ],
    logger: { info() {} },
  });
  databases.push(database);
  return {
    database,
    repository: new LegacySequelizeRunRepository(database),
  };
}

class FakeExecutor {
  type = 'local_process';
  starts = [];
  stops = [];
  completion = deferred();
  startError = undefined;
  handleOverrides = {};
  onStart = async () => undefined;

  capabilities() {
    return {
      timeout: true,
      processGroupTermination: true,
      workingDirectory: true,
      isolatedEnvironment: true,
      memoryLimit: 'none',
      cpuLimit: 'none',
      filesystemIsolation: 'none',
      networkIsolation: 'none',
    };
  }

  async start(spec, context) {
    this.starts.push({ spec, context });
    await this.onStart(spec, context);
    if (this.startError) throw this.startError;
    return {
      id: nextId(),
      executorType: this.type,
      runId: spec.runId,
      attemptId: spec.attemptId,
      startedAtMs: BASE_TIME + 10,
      pid: 4321,
      completion: this.completion.promise,
      ...this.handleOverrides,
    };
  }

  async stop(handle, reason) {
    this.stops.push({ handle, reason });
    return {
      status: 'termination_requested',
      termSignalSent: true,
      killSignalSent: false,
    };
  }

  async inspect() {
    return { status: 'running' };
  }
}

class FailingTransactionRepository {
  transactionCount = 0;

  constructor(repository, failAt) {
    this.repository = repository;
    this.failAt = failAt;
  }

  findRunById(runId) {
    return this.repository.findRunById(runId);
  }

  findAttemptById(attemptId) {
    return this.repository.findAttemptById(attemptId);
  }

  listEvents(runId, options) {
    return this.repository.listEvents(runId, options);
  }

  transaction(work) {
    this.transactionCount += 1;
    if (this.transactionCount === this.failAt) {
      return Promise.reject(new Error('injected transaction failure'));
    }
    return this.repository.transaction(work);
  }
}

class CompletionConflictRepository {
  conflict = false;

  constructor(repository) {
    this.repository = repository;
  }

  findRunById(runId) {
    return this.repository.findRunById(runId);
  }

  findAttemptById(attemptId) {
    return this.repository.findAttemptById(attemptId);
  }

  listEvents(runId, options) {
    return this.repository.listEvents(runId, options);
  }

  listCancellationRequested(options) {
    return this.repository.listCancellationRequested(options);
  }

  transaction(work) {
    return this.repository.transaction((transaction) =>
      work(
        new Proxy(transaction, {
          get: (target, property) => {
            if (property === 'compareAndSetRun' && this.conflict) {
              return async () => {
                this.conflict = false;
                return false;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ),
    );
  }
}

function startCommand(overrides = {}) {
  return {
    definition: {
      projectId: 'default',
      taskId: 'legacy-cron:7',
      taskRevision: 'revision-7',
      taskName: 'primary manual run',
      legacyCronId: 7,
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: BASE_TIME,
      actor: { type: 'user', id: 'user:1' },
    },
    createSpec(reference) {
      return {
        runId: reference.run.id,
        attemptId: reference.attempt.id,
        projectId: reference.run.projectId,
        taskId: reference.run.taskId,
        taskRevision: reference.run.taskRevision,
        command: { kind: 'argv', file: '/bin/true', args: [] },
        environmentPolicy: 'isolated',
        ...(overrides.timeoutMs === undefined
          ? {}
          : { timeoutMs: overrides.timeoutMs }),
        terminationGraceMs: 100,
      };
    },
    context: {
      environment: {},
      output: { async write() {} },
    },
    ...overrides,
  };
}

function result(outcome, overrides = {}) {
  return {
    outcome,
    startedAtMs: BASE_TIME + 10,
    finishedAtMs: BASE_TIME + 20,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('persists only a trusted retry policy resolved from immutable task identity', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const requests = [];
  executor.onStart = async (spec) => {
    assert.deepEqual(await repository.findRetryPolicyByRunId(spec.runId), {
      runId: spec.runId,
      maxAttempts: 3,
      retryOnLost: true,
      safety: 'idempotent',
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      version: 0,
      createdAtMs: BASE_TIME,
      updatedAtMs: BASE_TIME,
    });
  };
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    retryPolicyAdmission: {
      async resolve(request) {
        requests.push(request);
        assert.equal(Object.isFrozen(request), true);
        return {
          maxAttempts: 3,
          retryOnLost: true,
          safety: 'idempotent',
          backoffBaseMs: 1_000,
          backoffMaxMs: 30_000,
        };
      },
    },
  });

  const active = await orchestrator.start(startCommand());
  assert.deepEqual(requests, [
    {
      projectId: 'default',
      taskId: 'legacy-cron:7',
      taskRevision: 'revision-7',
      triggerType: 'manual',
      executionOrigin: 'manual',
    },
  ]);
  assert.equal('actor' in requests[0], false);
  assert.equal('taskName' in requests[0], false);
  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  await active.completion;
});

test('creates no retry policy when no trusted admission provider is configured', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  const active = await orchestrator.start(startCommand());
  assert.equal(await repository.findRetryPolicyByRunId(active.run.id), null);
  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  await active.completion;
});

test('rejects request-supplied retry safety before creating or spawning a Run', async () => {
  const { database, repository } = await createRepositoryWithDatabase();
  const executor = new FakeExecutor();
  const admissionRequests = [];
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    retryPolicyAdmission: {
      async resolve(request) {
        admissionRequests.push(request);
        return undefined;
      },
    },
  });
  const command = startCommand();
  command.definition.retryPolicy = {
    maxAttempts: 3,
    retryOnLost: true,
    safety: 'idempotent',
    backoffBaseMs: 1_000,
    backoffMaxMs: 30_000,
  };

  await assert.rejects(
    orchestrator.start(command),
    PrimaryRunRetryPolicyAuthorityError,
  );
  assert.deepEqual(admissionRequests, []);
  assert.equal(executor.starts.length, 0);
  assert.equal(
    Number(
      (await database.query('SELECT COUNT(*) AS count FROM Runs'))[0][0].count,
    ),
    0,
  );
});

test('rejects unsafe admitted automatic retry before creating or spawning a Run', async () => {
  const { database, repository } = await createRepositoryWithDatabase();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    retryPolicyAdmission: {
      async resolve() {
        return {
          maxAttempts: 2,
          retryOnLost: true,
          safety: 'unknown',
          backoffBaseMs: 1_000,
          backoffMaxMs: 30_000,
        };
      },
    },
  });

  await assert.rejects(
    orchestrator.start(startCommand()),
    InvalidRunRetryPolicyError,
  );
  assert.equal(executor.starts.length, 0);
  assert.equal(
    Number(
      (await database.query('SELECT COUNT(*) AS count FROM Runs'))[0][0].count,
    ),
    0,
  );
});

test('activates a recovered claimed Attempt N+1 without creating another Run', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    retryPolicyAdmission: {
      async resolve() {
        return {
          maxAttempts: 2,
          retryOnLost: true,
          safety: 'idempotent',
          backoffBaseMs: 0,
          backoffMaxMs: 0,
        };
      },
    },
  });
  const first = await orchestrator.start(startCommand());
  executor.completion.resolve(result('lost'));
  assert.equal((await first.completion).run.status, 'lost');
  await new Promise((resolve) => setImmediate(resolve));

  const retry = new RunLostRetryService(repository, {
    clock: { now: () => BASE_TIME + 30 },
    createId: nextId,
  });
  assert.equal((await retry.reconcile(first.run.id)).status, 'scheduled');
  const requeued = await retry.reconcile(first.run.id);
  assert.equal(requeued.status, 'requeued');
  assert.equal(requeued.attempt.attempt, 2);

  await assert.rejects(
    orchestrator.activateClaimed({
      runId: first.run.id,
      attemptId: first.attempt.id,
      createSpec: startCommand().createSpec,
      context: { environment: {}, output: { async write() {} } },
    }),
    (error) =>
      error instanceof PrimaryClaimedRunRejectedError &&
      error.reason === 'not_latest_attempt',
  );
  assert.equal(executor.starts.length, 1);

  executor.completion = deferred();
  executor.onStart = async (spec, context) => {
    assert.equal(spec.runId, first.run.id);
    assert.equal(spec.attemptId, requeued.attempt.id);
    assert.equal(context.completionCallback.callbackSequence, 1);
    assert.equal(
      (await repository.findAttemptById(first.attempt.id)).status,
      'lost',
    );
  };
  const active = await orchestrator.activateClaimed({
    runId: first.run.id,
    attemptId: requeued.attempt.id,
    createSpec: startCommand().createSpec,
    context: { environment: {}, output: { async write() {} } },
  });
  assert.equal(active.run.id, first.run.id);
  assert.equal(active.attempt.id, requeued.attempt.id);
  assert.equal(active.attempt.attempt, 2);
  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  const completed = await active.completion;
  assert.equal(completed.run.status, 'succeeded');
  assert.equal(completed.attempt.status, 'succeeded');
  assert.equal(
    (await repository.findLatestAttemptByRunId(first.run.id)).id,
    requeued.attempt.id,
  );
});

test('serializes claimed activation before spawn so only one caller can execute', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const reference = await new PrimaryRunCreator(repository, nextId).create(
    {
      projectId: 'default',
      taskId: 'legacy-cron:7',
      taskRevision: 'revision-7',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: BASE_TIME,
      actor: { type: 'scheduler' },
    },
    executor.type,
  );
  const enteredSpawn = deferred();
  const allowSpawn = deferred();
  executor.onStart = async () => {
    enteredSpawn.resolve();
    await allowSpawn.promise;
  };
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const command = {
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    createSpec: startCommand().createSpec,
    context: { environment: {}, output: { async write() {} } },
  };

  const first = orchestrator.activateClaimed(command);
  await enteredSpawn.promise;
  await assert.rejects(
    orchestrator.activateClaimed(command),
    (error) =>
      error instanceof PrimaryClaimedRunRejectedError &&
      error.reason === 'not_queued',
  );
  assert.equal(executor.starts.length, 1);

  allowSpawn.resolve();
  const active = await first;
  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  await active.completion;
});

test('rejects a claimed Attempt owned by another executor before side effects', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const reference = await new PrimaryRunCreator(repository, nextId).create(
    {
      projectId: 'default',
      taskId: 'task:remote',
      taskRevision: 'revision-remote',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: BASE_TIME,
      actor: { type: 'scheduler' },
    },
    'remote_worker',
  );
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  await assert.rejects(
    orchestrator.activateClaimed({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      createSpec: startCommand().createSpec,
      context: { environment: {}, output: { async write() {} } },
    }),
    (error) =>
      error instanceof PrimaryClaimedRunRejectedError &&
      error.reason === 'executor_mismatch',
  );
  assert.equal(executor.starts.length, 0);
  assert.equal(
    (await repository.findRunById(reference.run.id)).status,
    'queued',
  );
});

test('rejects stale execution authority on a claimed Attempt before side effects', async () => {
  const persisted = await createRepository();
  const executor = new FakeExecutor();
  const reference = await new PrimaryRunCreator(persisted, nextId).create(
    {
      projectId: 'default',
      taskId: 'task:contaminated',
      taskRevision: 'revision-contaminated',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: BASE_TIME,
      actor: { type: 'scheduler' },
    },
    executor.type,
  );
  const contaminated = {
    ...reference.attempt,
    callbackTokenHash: 'a'.repeat(64),
  };
  const repository = {
    findRunById: persisted.findRunById.bind(persisted),
    async findAttemptById() {
      return contaminated;
    },
    async findLatestAttemptByRunId() {
      return contaminated;
    },
    findRetryPolicyByRunId: persisted.findRetryPolicyByRunId.bind(persisted),
    listEvents: persisted.listEvents.bind(persisted),
    listCancellationRequested:
      persisted.listCancellationRequested.bind(persisted),
    transaction: persisted.transaction.bind(persisted),
  };
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  await assert.rejects(
    orchestrator.activateClaimed({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      createSpec: startCommand().createSpec,
      context: { environment: {}, output: { async write() {} } },
    }),
    (error) =>
      error instanceof PrimaryClaimedRunRejectedError &&
      error.reason === 'stale_execution_authority',
  );
  assert.equal(executor.starts.length, 0);
});

test('persists the Primary Run and starting Attempt before spawning', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const registrations = [];
  executor.onStart = async (spec, context) => {
    const [run, attempt, events] = await Promise.all([
      repository.findRunById(spec.runId),
      repository.findAttemptById(spec.attemptId),
      repository.listEvents(spec.runId),
    ]);
    assert.equal(run.status, 'dispatching');
    assert.equal(run.executionOwner, 'runtime');
    assert.equal(attempt.status, 'starting');
    assert.equal(attempt.deadlineAtMs, BASE_TIME + 5 + 5_000);
    assert.equal(context.completionCallback.callbackSequence, 1);
    assert.equal(
      attempt.callbackTokenHash,
      hashPrimaryCompletionToken(context.completionCallback.token),
    );
    assert.doesNotMatch(
      JSON.stringify(attempt),
      new RegExp(context.completionCallback.token),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['run.created', 'run.queued', 'run.dispatching', 'attempt.starting'],
    );
    assert.deepEqual(registrations, [
      {
        runId: spec.runId,
        attemptId: spec.attemptId,
        registeredAtMs: BASE_TIME,
      },
    ]);
  };
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    completionReceiptJournal: {
      async register(command) {
        registrations.push(command);
      },
    },
  });

  const active = await orchestrator.start(startCommand({ timeoutMs: 5_000 }));
  assert.equal(orchestrator.isActive(active.run.id), true);
  assert.equal(active.run.status, 'running');
  assert.equal(active.attempt.status, 'running');
  assert.equal(active.attempt.executorHandle, active.handle.id);
  assert.equal(active.attempt.pid, 4321);
  assert.equal(active.attempt.deadlineAtMs, BASE_TIME + 5 + 5_000);

  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  const completed = await active.completion;
  assert.equal(completed.run.status, 'succeeded');
  assert.equal(completed.attempt.status, 'succeeded');
  assert.equal(completed.attempt.callbackSequence, 1);
  assert.equal(orchestrator.isActive(active.run.id), false);
  assert.deepEqual(
    (await repository.listEvents(active.run.id)).map((event) => event.type),
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

test('persists a claimed Attempt Artifact before spawn and validates it before state changes', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const reference = await new PrimaryRunCreator(repository, nextId).create(
    {
      projectId: 'default',
      taskId: 'task:artifact',
      taskRevision: 'revision-artifact',
      triggerType: 'manual',
      executionOrigin: 'manual',
      acceptedAtMs: BASE_TIME,
      actor: { type: 'scheduler' },
    },
    executor.type,
  );
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const logArtifactId = `local-${'b'.repeat(30)}`;
  executor.onStart = async () => {
    const starting = await repository.findAttemptById(reference.attempt.id);
    assert.equal(starting.status, 'starting');
    assert.equal(starting.logArtifactId, logArtifactId);
  };

  await assert.rejects(
    orchestrator.activateClaimed({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      createSpec: startCommand().createSpec,
      context: { environment: {}, output: { async write() {} } },
      logArtifactId: '../escape',
    }),
    /logArtifactId is invalid/,
  );
  assert.equal(
    (await repository.findRunById(reference.run.id)).status,
    'queued',
  );
  assert.equal(executor.starts.length, 0);

  const active = await orchestrator.activateClaimed({
    runId: reference.run.id,
    attemptId: reference.attempt.id,
    createSpec: startCommand().createSpec,
    context: { environment: {}, output: { async write() {} } },
    logArtifactId,
  });
  assert.equal(active.attempt.logArtifactId, logArtifactId);
  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  const completed = await active.completion;
  assert.equal(completed.attempt.logArtifactId, logArtifactId);
});

test('persists a durable Executor handle instead of its process-local id', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  executor.handleOverrides = { durableHandle: 'ql3lp1.test-durable-handle' };
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  const active = await orchestrator.start(startCommand());
  assert.equal(active.attempt.executorHandle, 'ql3lp1.test-durable-handle');
  assert.notEqual(active.attempt.executorHandle, active.handle.id);

  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  await active.completion;
});

test('records a safe terminal failure when Executor.start rejects', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  executor.startError = new Error('secret command and path');
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  let launchError;
  try {
    await orchestrator.start(startCommand());
  } catch (error) {
    launchError = error;
  }
  assert.ok(launchError instanceof PrimaryRunLaunchError);
  const run = await repository.findRunById(launchError.reference.run.id);
  const attempt = await repository.findAttemptById(
    launchError.reference.attempt.id,
  );
  assert.equal(run.status, 'failed');
  assert.equal(attempt.status, 'failed');
  assert.equal(run.errorCode, 'EXECUTOR_START_FAILED');
  assert.doesNotMatch(run.errorSummary, /secret|path/);
  assert.equal(orchestrator.isActive(run.id), false);
});

test('does not spawn when completion receipt journal registration fails', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    completionReceiptJournal: {
      async register() {
        throw new Error('journal unavailable');
      },
    },
  });

  let launchError;
  try {
    await orchestrator.start(startCommand());
  } catch (error) {
    launchError = error;
  }
  assert.ok(launchError instanceof PrimaryRunLaunchError);
  assert.equal(executor.starts.length, 0);
  assert.equal(
    (await repository.findRunById(launchError.reference.run.id)).status,
    'failed',
  );
  assert.equal(
    (await repository.findAttemptById(launchError.reference.attempt.id)).status,
    'failed',
  );
});

test('cancels through the owning Executor and persists its eventual result', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const active = await orchestrator.start(startCommand());

  const stopExecutor = executor.stop.bind(executor);
  executor.stop = async (handle, reason) => {
    const [run, events] = await Promise.all([
      repository.findRunById(active.run.id),
      repository.listEvents(active.run.id),
    ]);
    assert.equal(run.cancelRequestedAtMs, BASE_TIME + 15);
    assert.equal(run.cancelReason, 'user');
    assert.equal(events.at(-1).type, 'run.cancel_requested');
    return stopExecutor(handle, reason);
  };

  const stop = await active.cancel({
    kind: 'user',
    requestedAtMs: BASE_TIME + 15,
  });
  assert.equal(stop.status, 'termination_requested');
  assert.equal(executor.stops.length, 1);
  executor.completion.resolve(result('cancelled'));

  const completed = await active.completion;
  assert.equal(completed.run.status, 'cancelled');
  assert.equal(completed.attempt.status, 'cancelled');
  assert.deepEqual(
    (await repository.listEvents(active.run.id)).map((event) => event.type),
    [
      'run.created',
      'run.queued',
      'run.dispatching',
      'attempt.starting',
      'attempt.running',
      'run.running',
      'run.cancel_requested',
      'attempt.cancelled',
      'run.cancelled',
    ],
  );
  await assert.rejects(
    orchestrator.cancel(active.run.id, {
      kind: 'user',
      requestedAtMs: BASE_TIME + 30,
    }),
    PrimaryRunNotActiveError,
  );
});

test('keeps the first cancel request and lets it win over a late success', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const active = await orchestrator.start(startCommand());

  await active.cancel({ kind: 'user', requestedAtMs: BASE_TIME + 15 });
  await active.cancel({ kind: 'policy', requestedAtMs: BASE_TIME + 16 });
  assert.equal(executor.stops.length, 2);
  const requested = await repository.findRunById(active.run.id);
  assert.equal(requested.cancelRequestedAtMs, BASE_TIME + 15);
  assert.equal(requested.cancelReason, 'user');
  assert.equal(
    (await repository.listEvents(active.run.id)).filter(
      (event) => event.type === 'run.cancel_requested',
    ).length,
    1,
  );

  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  const completed = await active.completion;
  assert.equal(completed.result.outcome, 'succeeded');
  assert.equal(completed.run.status, 'cancelled');
  assert.equal(completed.attempt.status, 'cancelled');
  assert.equal(completed.attempt.exitCode, 0);
});

test('retries the atomic completion transaction after a CAS conflict', async () => {
  const persisted = await createRepository();
  const repository = new CompletionConflictRepository(persisted);
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const active = await orchestrator.start(startCommand());

  repository.conflict = true;
  executor.completion.resolve(result('succeeded', { exitCode: 0 }));

  const completed = await active.completion;
  assert.equal(completed.result.outcome, 'succeeded');
  assert.equal(completed.run.status, 'succeeded');
  assert.equal(completed.attempt.status, 'succeeded');
  assert.equal(
    (await persisted.listEvents(active.run.id)).filter(
      (event) => event.type === 'attempt.succeeded',
    ).length,
    1,
  );
});

test('does not signal the Executor when persisting cancellation fails', async () => {
  const persisted = await createRepository();
  const repository = new FailingTransactionRepository(persisted, 6);
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const active = await orchestrator.start(startCommand());

  await assert.rejects(
    active.cancel({ kind: 'user', requestedAtMs: BASE_TIME + 15 }),
    /injected transaction failure/,
  );
  assert.equal(executor.stops.length, 0);
  const run = await persisted.findRunById(active.run.id);
  assert.equal(run.cancelRequestedAtMs, undefined);
  assert.equal(
    (await persisted.listEvents(active.run.id)).some(
      (event) => event.type === 'run.cancel_requested',
    ),
    false,
  );

  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  assert.equal((await active.completion).run.status, 'succeeded');
});

test('does not signal after the Attempt completed before cancellation', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const active = await orchestrator.start(startCommand());
  await new PrimaryRunCompletionService(repository, nextId).complete({
    runId: active.run.id,
    attemptId: active.attempt.id,
    callbackSequence: 1,
    result: result('succeeded', { exitCode: 0 }),
    source: { kind: 'executor', executorType: executor.type },
  });

  const stop = await active.cancel({
    kind: 'user',
    requestedAtMs: BASE_TIME + 21,
  });
  assert.deepEqual(stop, {
    status: 'already_exited',
    termSignalSent: false,
    killSignalSent: false,
  });
  assert.equal(executor.stops.length, 0);
  assert.equal(
    (await repository.listEvents(active.run.id)).some(
      (event) => event.type === 'run.cancel_requested',
    ),
    false,
  );

  executor.completion.resolve(result('succeeded', { exitCode: 0 }));
  assert.equal((await active.completion).run.status, 'succeeded');
});

test('compensates a mismatched spawned handle with stop and lost state', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  executor.handleOverrides = { attemptId: nextId() };
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  let launchError;
  try {
    await orchestrator.start(startCommand());
  } catch (error) {
    launchError = error;
  }
  assert.ok(launchError instanceof PrimaryRunLaunchError);
  assert.equal(executor.stops.length, 1);
  assert.equal(executor.stops[0].reason.kind, 'reconcile');
  assert.equal(launchError.reference.run.status, 'lost');
  assert.equal(launchError.reference.attempt.status, 'lost');
});

test('stops the process when persisting running ownership fails', async () => {
  const persisted = await createRepository();
  // create, dispatching, starting, attempt.running, then run.running fails.
  const repository = new FailingTransactionRepository(persisted, 5);
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });

  let launchError;
  try {
    await orchestrator.start(startCommand());
  } catch (error) {
    launchError = error;
  }
  assert.ok(launchError instanceof PrimaryRunLaunchError);
  assert.equal(executor.stops.length, 1);
  assert.equal(executor.stops[0].reason.kind, 'reconcile');
  assert.equal(launchError.reference.run.status, 'lost');
  assert.equal(launchError.reference.attempt.status, 'lost');
  assert.equal(repository.transactionCount, 7);
});

test('turns a rejected Executor completion channel into a durable lost state', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const active = await orchestrator.start(startCommand());

  executor.completion.reject(new Error('raw completion secret'));
  const completed = await active.completion;
  assert.equal(completed.run.status, 'lost');
  assert.equal(completed.attempt.status, 'lost');
  assert.equal(completed.run.errorCode, 'EXECUTION_LOST');
  assert.doesNotMatch(completed.run.errorSummary, /raw|secret/);
  assert.equal(orchestrator.isActive(active.run.id), false);
});

test('maps every non-success Executor outcome without persisting raw details', async () => {
  const cases = [
    ['failed', 'failed', 'EXECUTION_FAILED'],
    ['timed_out', 'timed_out', 'EXECUTION_TIMED_OUT'],
    ['lost', 'lost', 'EXECUTION_LOST'],
  ];

  for (const [outcome, status, errorCode] of cases) {
    const repository = await createRepository();
    const executor = new FakeExecutor();
    const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
      clock: { now: () => BASE_TIME + 5 },
      createId: nextId,
    });
    const active = await orchestrator.start(startCommand());
    executor.completion.resolve(
      result(outcome, {
        errorCode: 'UNTRUSTED_CODE',
        errorSummary: 'raw executor secret',
      }),
    );

    const completed = await active.completion;
    assert.equal(completed.run.status, status);
    assert.equal(completed.attempt.status, status);
    assert.equal(completed.run.errorCode, errorCode);
    assert.doesNotMatch(completed.run.errorSummary, /raw|secret/);
  }
});

test('requires an explicit lookup when a Primary idempotency key is supplied', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
  });
  const command = startCommand();
  command.definition.idempotencyKey = 'manual-request-7';

  await assert.rejects(
    orchestrator.start(command),
    PrimaryRunIdempotencyUnavailableError,
  );
  assert.equal(executor.starts.length, 0);
});

test('returns the existing Run for a duplicate idempotent request without spawning', async () => {
  const { database, repository } = await createRepositoryWithDatabase();
  const lookup = new LegacySequelizePrimaryRunIdempotencyLookup(database);
  const firstExecutor = new FakeExecutor();
  const first = new PrimaryRunOrchestrator(repository, firstExecutor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    idempotencyLookup: lookup,
  });
  const command = startCommand();
  command.definition.idempotencyKey = 'manual-request-7';
  const active = await first.start(command);

  const secondExecutor = new FakeExecutor();
  const second = new PrimaryRunOrchestrator(repository, secondExecutor, {
    clock: { now: () => BASE_TIME + 6 },
    createId: nextId,
    idempotencyLookup: lookup,
  });
  let duplicate;
  try {
    await second.start(command);
  } catch (error) {
    duplicate = error;
  }
  assert.ok(duplicate instanceof PrimaryRunDuplicateRequestError);
  assert.equal(duplicate.existingRunId, active.run.id);
  assert.equal(secondExecutor.starts.length, 0);

  firstExecutor.completion.resolve(result('succeeded', { exitCode: 0 }));
  await active.completion;
});

test('uses the unique index to close an idempotency preflight race', async () => {
  const { database, repository } = await createRepositoryWithDatabase();
  const lookup = new LegacySequelizePrimaryRunIdempotencyLookup(database);
  const firstExecutor = new FakeExecutor();
  const first = new PrimaryRunOrchestrator(repository, firstExecutor, {
    clock: { now: () => BASE_TIME + 5 },
    createId: nextId,
    idempotencyLookup: lookup,
  });
  const command = startCommand();
  command.definition.idempotencyKey = 'racing-request-7';
  const active = await first.start(command);

  let lookupCalls = 0;
  const staleOnceLookup = {
    async findRunId(projectId, idempotencyKey) {
      lookupCalls += 1;
      if (lookupCalls === 1) return null;
      return lookup.findRunId(projectId, idempotencyKey);
    },
  };
  const secondExecutor = new FakeExecutor();
  const second = new PrimaryRunOrchestrator(repository, secondExecutor, {
    clock: { now: () => BASE_TIME + 6 },
    createId: nextId,
    idempotencyLookup: staleOnceLookup,
  });

  let duplicate;
  try {
    await second.start(command);
  } catch (error) {
    duplicate = error;
  }
  assert.ok(duplicate instanceof PrimaryRunDuplicateRequestError);
  assert.equal(duplicate.existingRunId, active.run.id);
  assert.equal(lookupCalls, 2);
  assert.equal(secondExecutor.starts.length, 0);

  firstExecutor.completion.resolve(result('succeeded', { exitCode: 0 }));
  await active.completion;
});
