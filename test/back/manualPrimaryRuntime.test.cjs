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
  ManualPrimaryOwnershipError,
  ManualPrimaryRuntime,
} = require('../../back/runtime/application/manualPrimaryRuntime');
const {
  installManualPrimaryExecutionRouter,
  selectManualPrimaryExecutionRouter,
  stopManualPrimaryAttempt,
  stopManualPrimaryCron,
} = require('../../back/runtime/compatibility/manualPrimaryExecutionBridge');
const {
  parseLegacyLogOutputRef,
} = require('../../back/runtime/compatibility/legacyLogOutputRef');
const {
  RuntimeRolloutPolicy,
} = require('../../back/runtime/domain/runtimeRollout');

const databases = [];
const restorers = [];
const BASE_TIME = 1_750_000_000_000;
let idSequence = 1_100;

function nextId() {
  idSequence += 1;
  return '019f7120-0000-7000-8000-' + String(idSequence).padStart(12, '0');
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

function rollout(mode) {
  return new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: { manual: mode },
    allowLegacyFallbackBeforeStart: false,
  });
}

class FakeExecutor {
  type = 'local_process';
  starts = [];
  stops = [];
  completion = deferred();

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
    if (context.signal && context.signal.aborted) {
      throw new Error('aborted before fake spawn');
    }
    return {
      id: nextId(),
      executorType: this.type,
      runId: spec.runId,
      attemptId: spec.attemptId,
      startedAtMs: BASE_TIME + 10,
      pid: 7301,
      completion: this.completion.promise,
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

class FakeLogs {
  prepareCalls = 0;
  closeCalls = 0;
  committedAttempts = [];
  writes = [];

  async prepare(input) {
    this.prepareCalls += 1;
    return {
      logPath: 'task-' + input.cron.id + '/manual.log',
      output: {
        write: async (output) => {
          this.writes.push(output);
        },
      },
      completionCommitted: async (attemptId) => {
        this.committedAttempts.push(attemptId);
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

function input(cronId = 21) {
  return {
    cron: {
      id: cronId,
      name: 'manual primary',
      command: 'demo.js arg',
      schedule: '0 * * * *',
      extraSchedules: ['30 * * * *'],
      taskBefore: 'echo before',
      taskAfter: 'echo after',
      workDirectory: '/tmp',
      logName: 'task-' + cronId,
    },
    acceptedAtMs: BASE_TIME,
  };
}

afterEach(async () => {
  while (restorers.length > 0) restorers.pop()();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('off mode selects Legacy without preparing logs or spawning', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const logs = new FakeLogs();
  const runtime = new ManualPrimaryRuntime(
    repository,
    executor,
    rollout('off'),
    logs,
    { orchestrator: { createId: nextId } },
  );

  assert.equal(runtime.ownsNewRuns(), false);
  await assert.rejects(runtime.start(input()), ManualPrimaryOwnershipError);
  assert.equal(logs.prepareCalls, 0);
  assert.equal(executor.starts.length, 0);
});

test('Primary mode builds one durable Run and one legacy-compatible spec', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const logs = new FakeLogs();
  const runtime = new ManualPrimaryRuntime(
    repository,
    executor,
    rollout('primary'),
    logs,
    {
      clock: { now: () => BASE_TIME + 20 },
      orchestrator: { createId: nextId },
    },
  );

  const active = await runtime.start(input());
  assert.equal(executor.starts.length, 1);
  assert.equal(active.pid, 7301);
  assert.equal(active.logPath, 'task-21/manual.log');
  const started = executor.starts[0];
  assert.equal(started.spec.command.kind, 'shell');
  assert.match(
    started.spec.command.command,
    /real_log_path='task-21\/manual\.log'/,
  );
  assert.match(started.spec.command.command, /task demo\.js arg/);
  assert.equal(started.spec.environmentPolicy, 'inherit');
  assert.equal(started.context.signal.aborted, false);

  const run = await repository.findRunById(active.runId);
  assert.equal(run.executionOwner, 'runtime');
  assert.equal(run.executionOrigin, 'manual');
  assert.equal(parseLegacyLogOutputRef(run.outputRef), 'task-21/manual.log');

  executor.completion.resolve({
    outcome: 'succeeded',
    startedAtMs: BASE_TIME + 10,
    finishedAtMs: BASE_TIME + 30,
    exitCode: 0,
  });
  const completed = await active.completion;
  assert.equal(completed.outcome, 'succeeded');
  assert.equal(completed.exitCode, 0);
  assert.deepEqual(logs.committedAttempts, [active.attemptId]);
  assert.equal(logs.closeCalls, 1);
});

test('routes stop by cron and attempt through the owning Executor', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const runtime = new ManualPrimaryRuntime(
    repository,
    executor,
    rollout('primary'),
    new FakeLogs(),
    { orchestrator: { createId: nextId } },
  );
  const active = await runtime.start(input(22));

  assert.deepEqual(await runtime.stopCron(999, BASE_TIME + 40), {
    matched: 0,
    failed: 0,
  });
  assert.deepEqual(
    await runtime.stopAttempt(active.attemptId, BASE_TIME + 41),
    { matched: 1, failed: 0 },
  );
  assert.equal(executor.stops.length, 1);
  assert.equal(executor.stops[0].reason.kind, 'user');

  executor.completion.resolve({
    outcome: 'cancelled',
    startedAtMs: BASE_TIME + 10,
    finishedAtMs: BASE_TIME + 50,
    exitCode: 143,
  });
  assert.equal((await active.completion).outcome, 'cancelled');
});

test('a stop racing log preparation aborts before Executor side effects', async () => {
  const repository = await createRepository();
  const executor = new FakeExecutor();
  const preparing = deferred();
  const release = deferred();
  const logs = {
    async prepare() {
      preparing.resolve();
      await release.promise;
      return {
        logPath: 'task-24/racing.log',
        output: { async write() {} },
        async close() {},
      };
    },
  };
  const runtime = new ManualPrimaryRuntime(
    repository,
    executor,
    rollout('primary'),
    logs,
    { orchestrator: { createId: nextId } },
  );

  const starting = runtime.start(input(24));
  await preparing.promise;
  assert.deepEqual(await runtime.stopCron(24, BASE_TIME + 1), {
    matched: 1,
    failed: 0,
  });
  release.resolve();
  await assert.rejects(starting);
  assert.equal(executor.starts.length, 1);
  assert.equal(executor.starts[0].context.signal.aborted, true);
});

test('bridge is default-off and keeps stop routing available for its owner', async () => {
  assert.equal(selectManualPrimaryExecutionRouter(), undefined);
  assert.deepEqual(await stopManualPrimaryCron(1, BASE_TIME), {
    matched: 0,
    failed: 0,
  });

  const calls = [];
  const router = {
    ownsNewRuns: () => true,
    async start() {
      throw new Error('not used');
    },
    async stopCron(cronId, requestedAtMs) {
      calls.push(['cron', cronId, requestedAtMs]);
      return { matched: 1, failed: 0 };
    },
    async stopAttempt(attemptId, requestedAtMs) {
      calls.push(['attempt', attemptId, requestedAtMs]);
      return { matched: 1, failed: 0 };
    },
  };
  restorers.push(installManualPrimaryExecutionRouter(router));
  assert.equal(selectManualPrimaryExecutionRouter(), router);
  assert.deepEqual(await stopManualPrimaryCron(23, BASE_TIME + 1), {
    matched: 1,
    failed: 0,
  });
  assert.deepEqual(
    await stopManualPrimaryAttempt('attempt-23', BASE_TIME + 2),
    {
      matched: 1,
      failed: 0,
    },
  );
  assert.deepEqual(calls, [
    ['cron', 23, BASE_TIME + 1],
    ['attempt', 'attempt-23', BASE_TIME + 2],
  ]);
});

test('rolling new triggers to off preserves the previous in-flight stop owner', async () => {
  const oldOwner = {
    ownsNewRuns: () => true,
    async start() {
      throw new Error('not used');
    },
    async stopCron(cronId) {
      return {
        matched: cronId === 25 ? 1 : 0,
        failed: 0,
      };
    },
    async stopAttempt() {
      return { matched: 0, failed: 0 };
    },
  };
  const offRouter = {
    ownsNewRuns: () => false,
    async start() {
      throw new Error('not used');
    },
    async stopCron() {
      return { matched: 0, failed: 0 };
    },
    async stopAttempt() {
      return { matched: 0, failed: 0 };
    },
  };
  restorers.push(installManualPrimaryExecutionRouter(oldOwner));
  restorers.push(installManualPrimaryExecutionRouter(offRouter));

  assert.equal(selectManualPrimaryExecutionRouter(), undefined);
  assert.deepEqual(await stopManualPrimaryCron(25, BASE_TIME + 3), {
    matched: 1,
    failed: 0,
  });
});
