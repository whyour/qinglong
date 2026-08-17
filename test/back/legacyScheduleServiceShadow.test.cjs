require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const ScheduleService = require('../../back/services/schedule').default;
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
  installLegacyExecutionObserver,
} = require('../../back/runtime/compatibility/legacyExecutionBridge');
const {
  shadowOnlyRollout,
} = require('../../back/runtime/domain/runtimeRollout');

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

test('admits the three reviewed origins through the default environment boundary', () => {
  const source = `
    const bridge = require('./back/runtime/compatibility/legacyExecutionBridge');
    const fact = (origin) => ({
      origin,
      projectId: 'default',
      taskId: 'opaque',
      taskRevision: 'sha256:${'1'.repeat(64)}',
      triggerType: origin,
      acceptedAtMs: 1,
    });
    const result = ['subscription', 'system', 'script', 'boot'].map((origin) =>
      Boolean(bridge.observeLegacyExecution(origin, () => fact(origin))),
    );
    process.stdout.write(JSON.stringify(result));
    process.exit(result.join(',') === 'true,true,true,false' ? 0 : 1);
  `;
  const child = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', source],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        QL3_SHADOW_ORIGINS: 'subscription,system,script',
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '[true,true,true,false]');
});

test('observes subscription, system and script children without replacing legacy execution', async () => {
  const facts = [];
  const restore = installLegacyExecutionObserver(
    {
      begin(fact) {
        const lifecycle = [];
        facts.push({ fact, lifecycle });
        return {
          spawned: (value) => lifecycle.push(['spawned', value]),
          running: (value) => lifecycle.push(['running', value]),
          startFailed: (value) => lifecycle.push(['start_failed', value]),
          exited: (value) => lifecycle.push(['exited', value]),
          cancelled: (value) => lifecycle.push(['cancelled', value]),
        };
      },
    },
    ['subscription', 'system', 'script'],
  );

  try {
    const service = new ScheduleService(logger());
    for (const runOrigin of ['subscription', 'system', 'script']) {
      let resolveEnd;
      const ended = new Promise((resolve) => {
        resolveEnd = resolve;
      });
      const result = await service.runTask(
        successfulCommand(),
        { onEnd: async () => resolveEnd() },
        {
          id: `private/path/${runOrigin}`,
          name: `${runOrigin} task`,
          schedule: '0 * * * *',
          runOrigin,
        },
        runOrigin === 'script' ? 'start' : 'end',
      );
      if (runOrigin === 'script') {
        assert.equal(result > 0, true);
        await ended;
      } else {
        assert.equal(result.code, 0);
      }
    }
  } finally {
    restore();
  }

  assert.equal(facts.length, 3);
  assert.deepEqual(
    facts.map(({ fact }) => fact.origin),
    ['subscription', 'system', 'script'],
  );
  for (const { fact, lifecycle } of facts) {
    assert.equal(fact.projectId, 'default');
    assert.match(
      fact.taskId,
      new RegExp(`^legacy-schedule:${fact.origin}:[0-9a-f]{25}$`, 'u'),
    );
    assert.equal(fact.taskId.includes('private/path'), false);
    assert.match(fact.taskRevision, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(fact.triggerType, fact.origin);
    assert.equal(fact.triggeredBy, 'legacy:schedule-service');
    assert.equal(Number.isSafeInteger(fact.acceptedAtMs), true);
    assert.deepEqual(
      lifecycle.map(([operation]) => operation),
      ['spawned', 'running', 'exited'],
    );
    assert.equal(lifecycle[0][1].pid > 0, true);
    assert.equal(
      lifecycle[0][1].executorHandle.startsWith('legacy-local:'),
      true,
    );
    assert.equal(lifecycle[2][1].exitCode, 0);
  }
});

test('does not construct shadow facts for an origin that was not enabled', async () => {
  let accepted = 0;
  const restore = installLegacyExecutionObserver(
    {
      begin() {
        accepted += 1;
        throw new Error('disabled origin must not reach the observer');
      },
    },
    ['manual'],
  );

  try {
    const service = new ScheduleService(logger());
    const result = await service.runTask(
      successfulCommand(),
      {},
      {
        id: 'system-disabled',
        runOrigin: 'system',
      },
    );
    assert.equal(result.code, 0);
  } finally {
    restore();
  }

  assert.equal(accepted, 0);
});

test('keeps legacy execution successful when the enabled shadow observer fails', async () => {
  const restore = installLegacyExecutionObserver(
    {
      begin() {
        throw new Error('shadow storage unavailable');
      },
    },
    ['system'],
  );

  try {
    const service = new ScheduleService(logger());
    const result = await service.runTask(
      successfulCommand(),
      {},
      {
        id: 'shadow-failure',
        runOrigin: 'system',
      },
    );
    assert.equal(result.code, 0);
  } finally {
    restore();
  }
});

test('persists one legacy-owned terminal Run aggregate for a scheduled service child', async () => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const runId = '019f70f0-0000-7000-8000-000000000801';
  const attemptId = '019f70f0-0000-7000-8000-000000000802';
  const observations = [];
  const failures = [];
  let idSequence = 800;

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
      return `019f70f0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
    });
    const delegate = new LegacyShadowRunObserver(
      shadowOnlyRollout(['system']),
      writer,
      { failure: (failure) => failures.push(failure) },
    );
    const restore = installLegacyExecutionObserver(
      {
        begin(fact) {
          const observation = delegate.begin(fact);
          observations.push(observation);
          return observation;
        },
      },
      ['system'],
    );

    try {
      const service = new ScheduleService(logger());
      const result = await service.runTask(
        successfulCommand(),
        {},
        {
          id: 'credential=must-not-persist',
          name: 'system maintenance',
          runOrigin: 'system',
        },
      );
      assert.equal(result.code, 0);
      assert.equal(observations.length, 1);
      await observations[0].settled();
    } finally {
      restore();
    }

    const run = await repository.findRunById(runId);
    const attempt = await repository.findAttemptById(attemptId);
    const events = await repository.listEvents(runId);
    assert.deepEqual(failures, [], JSON.stringify(failures));
    assert.equal(run.executionOrigin, 'system');
    assert.equal(run.executionOwner, 'legacy');
    assert.equal(run.status, 'succeeded');
    assert.equal(run.taskId.includes('credential='), false);
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
