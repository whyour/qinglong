require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { Sequelize } = require('sequelize');
const { Container } = require('typedi');

const dataDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ql3-legacy-boot-shadow-'),
);
fs.mkdirSync(path.join(dataDirectory, 'db'), { recursive: true });
process.env.QL_DATA_DIR = dataDirectory;

const { CrontabModel, CrontabStatus } = require('../../back/data/cron');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const CronService = require('../../back/services/cron').default;
const { runCrons } = require('../../back/schedule/api');
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
  installLegacyExecutionObserver,
} = require('../../back/runtime/compatibility/legacyExecutionBridge');
const {
  shadowOnlyRollout,
} = require('../../back/runtime/domain/runtimeRollout');

after(() => {
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

function logger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function successfulCommand() {
  return `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
}

function cron(overrides = {}) {
  return {
    id: 71,
    name: 'boot probe',
    command: 'credential=must-not-persist',
    schedule: '@boot',
    status: CrontabStatus.queued,
    isDisabled: 0,
    extra_schedules: [],
    ...overrides,
  };
}

async function withStubbedCronUpdate(work) {
  const original = CrontabModel.update;
  const updates = [];
  CrontabModel.update = async (...args) => {
    updates.push(args);
    return [1];
  };
  try {
    return await work(updates);
  } finally {
    CrontabModel.update = original;
  }
}

test('bootTask selects only enabled @boot entries and fixes their origin before dispatch', async () => {
  await withStubbedCronUpdate(async (updates) => {
    const service = new CronService(logger());
    const dispatched = [];
    service.crontabs = async () => ({
      data: [
        cron({ id: 71 }),
        cron({ id: 72, isDisabled: 1 }),
        cron({ id: 73, schedule: '@once' }),
        cron({ id: 74, schedule: '0 * * * *' }),
      ],
      total: 4,
    });
    service.runSingle = (...args) => {
      dispatched.push(args);
    };

    await service.bootTask();

    assert.deepEqual(dispatched, [[71, 'boot']]);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0][0], { status: CrontabStatus.queued });
    assert.deepEqual(updates[0][1], { where: { id: [71] } });
  });
});

test('persists one legacy-owned terminal Run for the real boot child path', async () => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const observations = [];
  const failures = [];
  let idSequence = 900;

  try {
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
    const repository = new LegacySequelizeRunRepository(database);
    const writer = new LegacyShadowRunWriter(repository, () => {
      idSequence += 1;
      return `019f7100-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
    });
    const delegate = new LegacyShadowRunObserver(
      shadowOnlyRollout(['boot']),
      writer,
      { failure: (failure) => failures.push(failure) },
    );
    const restore = installLegacyExecutionObserver(
      {
        begin(fact) {
          const observation = delegate.begin(fact);
          observations.push({ fact, observation });
          return observation;
        },
      },
      ['boot'],
    );

    try {
      await withStubbedCronUpdate(async () => {
        const service = new CronService(logger());
        service.getDb = async () => cron();
        service.makeCommand = () => successfulCommand();

        const result = await service.runSingle(71, 'boot');
        assert.equal(result.code, 0);
        assert.equal(observations.length, 1);
        await observations[0].observation.settled();
      });
    } finally {
      restore();
    }

    const runId = '019f7100-0000-7000-8000-000000000901';
    const attemptId = '019f7100-0000-7000-8000-000000000902';
    const run = await repository.findRunById(runId);
    const attempt = await repository.findAttemptById(attemptId);
    const events = await repository.listEvents(runId);
    const fact = observations[0].fact;

    assert.deepEqual(failures, []);
    assert.equal(fact.origin, 'boot');
    assert.equal(fact.triggerType, 'boot');
    assert.equal(fact.triggeredBy, 'legacy:boot');
    assert.equal(fact.legacyCronId, 71);
    assert.match(fact.taskRevision, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(run.executionOrigin, 'boot');
    assert.equal(run.executionOwner, 'legacy');
    assert.equal(run.status, 'succeeded');
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.executorType, 'legacy_local');
    assert.equal(attempt.pid > 0, true);
    assert.equal(attempt.exitCode, 0);
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
    assert.equal(
      JSON.stringify({ run, attempt, events }).includes('credential='),
      false,
    );
  } finally {
    await database.close();
  }
});

test('@once remains a manual trigger instead of becoming an inferred execution origin', async () => {
  const facts = [];
  const restore = installLegacyExecutionObserver(
    {
      begin(fact) {
        facts.push(fact);
        return {
          spawned() {},
          running() {},
          startFailed() {},
          exited() {},
          cancelled() {},
        };
      },
    },
    ['manual', 'boot'],
  );

  try {
    await withStubbedCronUpdate(async () => {
      const service = new CronService(logger());
      service.getDb = async () => cron({ id: 81, schedule: '@once' });
      service.makeCommand = () => successfulCommand();

      const result = await service.runSingle(81);
      assert.equal(result.code, 0);
    });
  } finally {
    restore();
  }

  assert.equal(facts.length, 1);
  assert.equal(facts[0].origin, 'manual');
  assert.equal(facts[0].triggerType, 'manual');
  assert.equal(facts[0].triggeredBy, 'legacy:manual');
});

test('the legacy gRPC run endpoint delegates without inventing a grpc execution origin', async () => {
  await withStubbedCronUpdate(async () => {
    const service = new CronService(logger());
    const dispatched = [];
    service.runSingle = (...args) => {
      dispatched.push(args);
    };
    Container.set(CronService, service);

    try {
      const response = await new Promise((resolve, reject) => {
        runCrons({ request: { ids: [91] } }, (error, value) =>
          error ? reject(error) : resolve(value),
        );
      });
      assert.deepEqual(response, { code: 200 });
      assert.deepEqual(dispatched, [[91]]);
      assert.equal(dispatched[0].includes('grpc'), false);
    } finally {
      Container.remove(CronService);
    }
  });
});
