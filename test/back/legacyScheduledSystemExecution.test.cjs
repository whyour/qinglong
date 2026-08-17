require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const config = require('../../back/config').default;
const { CrontabModel } = require('../../back/data/cron');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const CronService = require('../../back/services/cron').default;
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
  decorateScheduledSystemCronCommand,
  observeLegacyScheduledSystemExecution,
  parseLegacyScheduledSystemExecutionId,
} = require('../../back/runtime/compatibility/legacyScheduledSystemExecution');
const {
  shadowOnlyRollout,
} = require('../../back/runtime/domain/runtimeRollout');

const EXECUTION_ID =
  'legacy-system:1787004000:123e4567-e89b-42d3-a456-426614174000';
const SECOND_EXECUTION_ID =
  'legacy-system:1787004060:123e4567-e89b-42d3-b456-426614174001';

function cron(overrides = {}) {
  return {
    id: 37,
    name: 'system scheduled task',
    command: 'task scripts/job.js',
    schedule: '*/5 * * * *',
    extra_schedules: [],
    ...overrides,
  };
}

async function databaseFixture() {
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
  return database;
}

async function runRows(database) {
  const [rows] = await database.query(
    'SELECT id FROM "Runs" ORDER BY created_at_ms, id',
  );
  return rows;
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

test('marks only system-crond commands and parses one bounded execution identity', () => {
  const command = 'real_time=false no_tee=true ID=37 task scripts/job.js';
  assert.equal(
    decorateScheduledSystemCronCommand(command, true),
    `QL_EXECUTION_ORIGIN=scheduled_system ${command}`,
  );
  assert.equal(decorateScheduledSystemCronCommand(command, false), command);
  assert.deepEqual(parseLegacyScheduledSystemExecutionId(EXECUTION_ID), {
    requestId: EXECUTION_ID,
    acceptedAtMs: 1_787_004_000_000,
  });
  for (const invalid of [
    '',
    'legacy-system:0:123e4567-e89b-42d3-a456-426614174000',
    'legacy-system:1787004000:123e4567-e89b-12d3-a456-426614174000',
    'manual:1787004000:123e4567-e89b-42d3-a456-426614174000',
  ]) {
    assert.equal(parseLegacyScheduledSystemExecutionId(invalid), undefined);
  }
});

test('Shell creates the identity only for an explicitly marked system execution', () => {
  const script = `
    . ./shell/api.sh
    first=$(create_legacy_system_execution_id 1787004000)
    QL_EXECUTION_ORIGIN=scheduled_system
    second=$(create_legacy_system_execution_id 1787004000)
    printf '%s\\n%s' "$first" "$second"
  `;
  const child = spawnSync('bash', ['-c', script], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const [unmarked, marked] = child.stdout.split('\n');
  assert.equal(unmarked, '');
  assert.match(
    marked,
    /^legacy-system:1787004000:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test('Shell sends the same execution identity as bounded callback JSON', async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-system-callback-'),
  );
  const capture = path.join(temporary, 'curl-arguments');
  const script = `
    . ./shell/api.sh
    curl() {
      printf '%s\\n' "$@" > "$CALLBACK_CAPTURE"
      printf '{"code":200}'
    }
    jq() {
      if [[ "$*" == *'.code'* ]]; then printf '200'; fi
    }
    update_cron '"37"' '0' '4321' 'task/run.log' '1787004000' '' '' "$EXECUTION_ID"
  `;
  try {
    const child = spawnSync('bash', ['-c', script], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        CALLBACK_CAPTURE: capture,
        EXECUTION_ID,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const args = (await fs.readFile(capture, 'utf8')).split('\n');
    const dataIndex = args.indexOf('--data-raw');
    assert.equal(dataIndex >= 0, true);
    assert.deepEqual(JSON.parse(args[dataIndex + 1]), {
      ids: ['37'],
      status: '0',
      pid: '4321',
      log_path: 'task/run.log',
      last_execution_time: 1_787_004_000,
      last_running_time: 0,
      execution_id: EXECUTION_ID,
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('CronService marks the real system crontab file but not the node scheduler file', async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-system-crontab-'),
  );
  const executableDirectory = path.join(temporary, 'bin');
  const crontabExecutable = path.join(executableDirectory, 'crontab');
  const capture = path.join(temporary, 'crontab-call');
  const crontabFile = path.join(temporary, 'crontab.list');
  const previous = {
    crontabFile: config.crontabFile,
    path: process.env.PATH,
    scheduler: process.env.QL_SCHEDULER,
    update: CrontabModel.update,
  };
  await fs.mkdir(executableDirectory);
  await fs.writeFile(
    crontabExecutable,
    '#!/bin/sh\nprintf "%s" "$1" > "$CRONTAB_CAPTURE"\n',
    { mode: 0o755 },
  );
  config.crontabFile = crontabFile;
  process.env.PATH = `${executableDirectory}:${process.env.PATH ?? ''}`;
  process.env.CRONTAB_CAPTURE = capture;
  CrontabModel.update = async () => [0];
  try {
    const service = new CronService(logger());
    process.env.QL_SCHEDULER = 'system';
    await service.setCrontab({ data: [cron()], total: 1 });
    const systemContent = await fs.readFile(crontabFile, 'utf8');
    assert.match(
      systemContent,
      /^\*\/5 \* \* \* \* QL_EXECUTION_ORIGIN=scheduled_system /u,
    );
    assert.equal(await fs.readFile(capture, 'utf8'), crontabFile);

    process.env.QL_SCHEDULER = 'node';
    await service.setCrontab({ data: [cron()], total: 1 });
    const nodeContent = await fs.readFile(crontabFile, 'utf8');
    assert.equal(nodeContent.includes('QL_EXECUTION_ORIGIN='), false);
  } finally {
    config.crontabFile = previous.crontabFile;
    process.env.PATH = previous.path;
    CrontabModel.update = previous.update;
    delete process.env.CRONTAB_CAPTURE;
    if (previous.scheduler === undefined) {
      delete process.env.QL_SCHEDULER;
    } else {
      process.env.QL_SCHEDULER = previous.scheduler;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('running, finish and response-loss replay converge to one durable aggregate', async () => {
  const database = await databaseFixture();
  const repository = new LegacySequelizeRunRepository(database);
  const failures = [];
  const observer = new LegacyShadowRunObserver(
    shadowOnlyRollout(['scheduled_system']),
    new LegacyShadowRunWriter(repository),
    { failure: (failure) => failures.push(failure) },
  );
  const restore = installLegacyExecutionObserver(observer, [
    'scheduled_system',
  ]);
  try {
    const running = observeLegacyScheduledSystemExecution(cron(), {
      executionId: EXECUTION_ID,
      phase: 'running',
      observedAtMs: 1_787_004_001_000,
      pid: 4321,
      logPath: 'task/run.log',
    });
    await running.settled();
    const finished = observeLegacyScheduledSystemExecution(cron(), {
      executionId: EXECUTION_ID,
      phase: 'finished',
      observedAtMs: 1_787_004_005_000,
      pid: 4321,
      logPath: 'task/run.log',
      exitCode: 0,
    });
    await finished.settled();
    const replay = observeLegacyScheduledSystemExecution(cron(), {
      executionId: EXECUTION_ID,
      phase: 'finished',
      observedAtMs: 1_787_004_005_000,
      pid: 4321,
      logPath: 'task/run.log',
      exitCode: 0,
    });
    await replay.settled();

    const rows = await runRows(database);
    assert.equal(rows.length, 1);
    assert.match(
      rows[0].id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const run = await repository.findRunById(rows[0].id);
    const attempt = await repository.findLatestAttemptByRunId(rows[0].id);
    const events = await repository.listEvents(rows[0].id);
    assert.deepEqual(failures, []);
    assert.equal(run.executionOrigin, 'scheduled_system');
    assert.equal(run.executionOwner, 'legacy');
    assert.equal(run.requestId, EXECUTION_ID);
    assert.equal(
      run.idempotencyKey,
      `legacy-shadow:scheduled_system:${EXECUTION_ID}`,
    );
    assert.equal(run.createdAtMs, 1_787_004_000_000);
    assert.equal(run.status, 'succeeded');
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.pid, 4321);
    assert.equal(events.length, 8);
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  } finally {
    restore();
    await database.close();
  }
});

test('finish-only delivery creates one terminal Run and exact replay stays idempotent', async () => {
  const database = await databaseFixture();
  const repository = new LegacySequelizeRunRepository(database);
  const failures = [];
  const restore = installLegacyExecutionObserver(
    new LegacyShadowRunObserver(
      shadowOnlyRollout(['scheduled_system']),
      new LegacyShadowRunWriter(repository),
      { failure: (failure) => failures.push(failure) },
    ),
    ['scheduled_system'],
  );
  try {
    for (let replay = 0; replay < 2; replay += 1) {
      const observation = observeLegacyScheduledSystemExecution(cron(), {
        executionId: SECOND_EXECUTION_ID,
        phase: 'finished',
        observedAtMs: 1_787_004_065_000,
        pid: 4322,
        exitCode: 17,
      });
      await observation.settled();
    }
    const rows = await runRows(database);
    assert.equal(rows.length, 1);
    const run = await repository.findRunById(rows[0].id);
    const attempt = await repository.findLatestAttemptByRunId(rows[0].id);
    assert.equal(run.status, 'failed');
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.exitCode, 17);
    assert.deepEqual(failures, []);
  } finally {
    restore();
    await database.close();
  }
});

test('same execution identity with changed task facts fails open without a second Run', async () => {
  const database = await databaseFixture();
  const repository = new LegacySequelizeRunRepository(database);
  const failures = [];
  const restore = installLegacyExecutionObserver(
    new LegacyShadowRunObserver(
      shadowOnlyRollout(['scheduled_system']),
      new LegacyShadowRunWriter(repository),
      { failure: (failure) => failures.push(failure) },
    ),
    ['scheduled_system'],
  );
  try {
    const first = observeLegacyScheduledSystemExecution(cron(), {
      executionId: EXECUTION_ID,
      phase: 'finished',
      observedAtMs: 1_787_004_005_000,
      exitCode: 0,
    });
    await first.settled();
    const drifted = observeLegacyScheduledSystemExecution(
      cron({ command: 'task scripts/changed.js' }),
      {
        executionId: EXECUTION_ID,
        phase: 'finished',
        observedAtMs: 1_787_004_005_000,
        exitCode: 0,
      },
    );
    await drifted.settled();
    assert.equal((await runRows(database)).length, 1);
    assert.equal(
      failures.some(
        (failure) =>
          failure.origin === 'scheduled_system' &&
          failure.operation === 'accept',
      ),
      true,
    );
  } finally {
    restore();
    await database.close();
  }
});
