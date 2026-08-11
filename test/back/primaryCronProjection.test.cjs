require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { DataTypes, QueryTypes, Sequelize } = require('sequelize');
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
  runningInstanceRunReferenceMigration,
} = require('../../back/migrations/0003-running-instance-run-reference');
const { runMigrations } = require('../../back/migrations/runner');
const {
  PrimaryCronProjection,
} = require('../../back/runtime/adapters/legacy-sequelize/primaryCronProjection');
const {
  LegacySequelizeProjectedRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectedRunRepository');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  PrimaryRunCreator,
} = require('../../back/runtime/application/primaryRunCreator');
const {
  PrimaryRunOrchestrator,
} = require('../../back/runtime/application/primaryRunOrchestrator');
const {
  RunCommandService,
} = require('../../back/runtime/application/runCommandService');
const {
  createLegacyLogOutputRef,
} = require('../../back/runtime/compatibility/legacyLogOutputRef');

const databases = [];
const BASE_TIME = 1_750_000_000_000;
let idSequence = 900;

function nextId() {
  idSequence += 1;
  return '019f7110-0000-7000-8000-' + String(idSequence).padStart(12, '0');
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

async function createLegacyTables(database) {
  const queryInterface = database.getQueryInterface();
  await queryInterface.createTable('Crontabs', {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
    },
    name: { type: DataTypes.STRING, allowNull: true },
    command: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.INTEGER, allowNull: true },
    pid: { type: DataTypes.INTEGER, allowNull: true },
    log_path: { type: DataTypes.STRING, allowNull: true },
    last_running_time: { type: DataTypes.INTEGER, allowNull: true },
    last_execution_time: { type: DataTypes.INTEGER, allowNull: true },
  });
  await queryInterface.createTable('RunningInstances', {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
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
}

async function createDatabase() {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  await createLegacyTables(database);
  const migrationModel = defineSchemaMigrationModel(database);
  await runMigrations({
    database,
    migrationModel,
    migrations: [
      runSchemaMigration,
      runningInstanceRunReferenceMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
    ],
    logger: { info() {} },
  });
  databases.push(database);
  return database;
}

async function seedCron(database, id) {
  await database.getQueryInterface().bulkInsert('Crontabs', [
    {
      id,
      name: 'cron-' + id,
      command: 'echo projected',
      status: 1,
      pid: null,
      log_path: null,
      last_running_time: null,
      last_execution_time: null,
    },
  ]);
}

async function readCron(database, id) {
  const rows = await database.query(
    'SELECT id, status, pid, log_path, last_running_time, last_execution_time FROM Crontabs WHERE id = :id',
    {
      replacements: { id },
      type: QueryTypes.SELECT,
    },
  );
  return rows[0] || null;
}

async function readInstances(database, cronId) {
  return database.query(
    'SELECT id, cron_id, run_id, attempt_id, pid, log_path, started_at, finished_at, status, exit_code FROM RunningInstances WHERE cron_id = :cronId ORDER BY id',
    {
      replacements: { cronId },
      type: QueryTypes.SELECT,
    },
  );
}

function projectedRepository(database, extraParticipants = []) {
  return new LegacySequelizeProjectedRunRepository(database, [
    new PrimaryCronProjection(database),
    ...extraParticipants,
  ]);
}

class FakeExecutor {
  type = 'local_process';
  completion = deferred();

  constructor(pid, startedAtMs) {
    this.pid = pid;
    this.startedAtMs = startedAtMs;
  }

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

  async start(spec) {
    return {
      id: 'handle-' + this.pid,
      executorType: this.type,
      runId: spec.runId,
      attemptId: spec.attemptId,
      startedAtMs: this.startedAtMs,
      pid: this.pid,
      completion: this.completion.promise,
    };
  }

  async stop() {
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

function startCommand(cronId, acceptedAtMs, logPath) {
  return {
    definition: {
      projectId: 'default',
      taskId: 'legacy-cron:' + cronId,
      taskRevision: 'revision-' + cronId,
      taskName: 'projected run ' + cronId,
      legacyCronId: cronId,
      triggerType: 'manual',
      executionOrigin: 'manual',
      outputRef: createLegacyLogOutputRef(logPath),
      acceptedAtMs,
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
        terminationGraceMs: 100,
      };
    },
    context: {
      environment: {},
      output: { async write() {} },
    },
  };
}

function result(outcome, startedAtMs, finishedAtMs, exitCode) {
  return {
    outcome,
    startedAtMs,
    finishedAtMs,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('projects a Primary Run and RunningInstance through success', async () => {
  const database = await createDatabase();
  await seedCron(database, 7);
  const repository = projectedRepository(database);
  const executor = new FakeExecutor(4321, BASE_TIME + 2_000);
  const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
    clock: { now: () => BASE_TIME + 3_000 },
    createId: nextId,
  });

  const active = await orchestrator.start(
    startCommand(7, BASE_TIME, 'task-7/primary.log'),
  );
  const runningCron = await readCron(database, 7);
  assert.equal(runningCron.status, 0);
  assert.equal(runningCron.pid, 4321);
  assert.equal(runningCron.log_path, 'task-7/primary.log');
  assert.equal(runningCron.last_execution_time, 1_750_000_003);

  let instances = await readInstances(database, 7);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].run_id, active.run.id);
  assert.equal(instances[0].attempt_id, active.attempt.id);
  assert.equal(instances[0].status, 0);
  assert.equal(instances[0].pid, 4321);
  assert.equal(instances[0].log_path, 'task-7/primary.log');

  executor.completion.resolve(
    result('succeeded', BASE_TIME + 2_000, BASE_TIME + 7_000, 0),
  );
  await active.completion;

  const finishedCron = await readCron(database, 7);
  assert.equal(finishedCron.status, 1);
  assert.equal(finishedCron.pid, null);
  assert.equal(finishedCron.log_path, 'task-7/primary.log');
  assert.equal(finishedCron.last_running_time, 4);
  instances = await readInstances(database, 7);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].status, 1);
  assert.equal(instances[0].finished_at, 1_750_000_007);
  assert.equal(instances[0].exit_code, 0);
});

test('maps failed and cancelled attempts into legacy instance states', async () => {
  const cases = [
    { cronId: 8, outcome: 'failed', expectedStatus: 3, exitCode: 17 },
    { cronId: 9, outcome: 'cancelled', expectedStatus: 2, exitCode: 143 },
  ];

  for (const item of cases) {
    const database = await createDatabase();
    await seedCron(database, item.cronId);
    const repository = projectedRepository(database);
    const executor = new FakeExecutor(4400 + item.cronId, BASE_TIME + 1_000);
    const orchestrator = new PrimaryRunOrchestrator(repository, executor, {
      clock: { now: () => BASE_TIME + 2_000 },
      createId: nextId,
    });
    const active = await orchestrator.start(
      startCommand(
        item.cronId,
        BASE_TIME,
        'task-' + item.cronId + '/primary.log',
      ),
    );

    executor.completion.resolve(
      result(item.outcome, BASE_TIME + 1_000, BASE_TIME + 4_000, item.exitCode),
    );
    await active.completion;

    const cron = await readCron(database, item.cronId);
    const instances = await readInstances(database, item.cronId);
    assert.equal(cron.status, 1);
    assert.equal(cron.pid, null);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].status, item.expectedStatus);
    assert.equal(instances[0].exit_code, item.exitCode);
  }
});

test('keeps Crontab running while another Primary instance remains active', async () => {
  const database = await createDatabase();
  await seedCron(database, 10);
  const repository = projectedRepository(database);
  const firstExecutor = new FakeExecutor(5101, BASE_TIME + 1_000);
  const firstOrchestrator = new PrimaryRunOrchestrator(
    repository,
    firstExecutor,
    {
      clock: { now: () => BASE_TIME + 2_000 },
      createId: nextId,
    },
  );
  const first = await firstOrchestrator.start(
    startCommand(10, BASE_TIME, 'task-10/first.log'),
  );

  const secondExecutor = new FakeExecutor(5102, BASE_TIME + 101_000);
  const secondOrchestrator = new PrimaryRunOrchestrator(
    repository,
    secondExecutor,
    {
      clock: { now: () => BASE_TIME + 102_000 },
      createId: nextId,
    },
  );
  const second = await secondOrchestrator.start(
    startCommand(10, BASE_TIME + 100_000, 'task-10/second.log'),
  );
  assert.equal((await readCron(database, 10)).pid, 5102);

  secondExecutor.completion.resolve(
    result('succeeded', BASE_TIME + 101_000, BASE_TIME + 104_000, 0),
  );
  await second.completion;
  const stillRunning = await readCron(database, 10);
  assert.equal(stillRunning.status, 0);
  assert.equal(stillRunning.pid, 5101);
  assert.equal(stillRunning.log_path, 'task-10/first.log');

  firstExecutor.completion.resolve(
    result('succeeded', BASE_TIME + 1_000, BASE_TIME + 106_000, 0),
  );
  await first.completion;
  assert.equal((await readCron(database, 10)).status, 1);
  assert.equal((await readInstances(database, 10)).length, 2);
});

test('rolls back Run, event and instance writes when projection fails', async () => {
  const database = await createDatabase();
  await seedCron(database, 11);
  const failure = {
    enabled: false,
    async apply() {
      if (this.enabled) throw new Error('injected projection failure');
    },
  };
  const repository = projectedRepository(database, [failure]);
  const creator = new PrimaryRunCreator(repository, nextId);
  const reference = await creator.create(
    {
      projectId: 'default',
      taskId: 'legacy-cron:11',
      taskRevision: 'revision-11',
      legacyCronId: 11,
      triggerType: 'manual',
      executionOrigin: 'manual',
      outputRef: createLegacyLogOutputRef('task-11/rollback.log'),
      acceptedAtMs: BASE_TIME,
      actor: { type: 'user', id: 'user:1' },
    },
    'local_process',
  );
  const commands = new RunCommandService(repository, nextId);
  const dispatching = await commands.transitionRun({
    runId: reference.run.id,
    to: 'dispatching',
    expectedVersion: reference.run.version,
    atMs: BASE_TIME + 1_000,
    actor: { type: 'system' },
  });
  failure.enabled = true;

  await assert.rejects(
    commands.transitionRunAttempt({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      to: 'starting',
      expectedRunVersion: dispatching.run.version,
      atMs: BASE_TIME + 2_000,
      actor: { type: 'executor', id: 'local_process' },
    }),
    /injected projection failure/,
  );

  const run = await repository.findRunById(reference.run.id);
  const attempt = await repository.findAttemptById(reference.attempt.id);
  assert.equal(run.status, 'dispatching');
  assert.equal(run.version, dispatching.run.version);
  assert.equal(attempt.status, 'claimed');
  assert.equal((await repository.listEvents(run.id)).length, 3);
  assert.equal((await readInstances(database, 11)).length, 0);
  assert.equal((await readCron(database, 11)).status, 3);
});

test('legacy Shadow repository never writes the Primary projection', async () => {
  const database = await createDatabase();
  await seedCron(database, 12);
  const repository = new LegacySequelizeRunRepository(database);
  const run = {
    id: nextId(),
    projectId: 'default',
    taskId: 'legacy-cron:12',
    taskRevision: 'revision-12',
    legacyCronId: 12,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'legacy',
    status: 'running',
    version: 0,
    eventSequence: 0,
    priority: 0,
    outputRef: createLegacyLogOutputRef('task-12/shadow.log'),
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 1_000,
  };
  const attempt = {
    id: nextId(),
    runId: run.id,
    attempt: 1,
    status: 'running',
    executorType: 'legacy_local',
    pid: 6200,
    callbackSequence: 0,
    createdAtMs: BASE_TIME,
    startedAtMs: BASE_TIME + 1_000,
  };
  await repository.transaction(async (transaction) => {
    await transaction.insertRun(run);
    await transaction.insertAttempt(attempt);
  });

  const cron = await readCron(database, 12);
  assert.equal(cron.status, 1);
  assert.equal(cron.pid, null);
  assert.equal(
    await readInstances(database, 12).then((rows) => rows.length),
    0,
  );
});
