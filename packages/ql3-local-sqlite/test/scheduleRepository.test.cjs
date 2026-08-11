const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  resolveLocalScheduleDecision,
} = require('@qinglong/runtime-core/local-scheduler');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  return Math.floor(afterMs / 60_000 + 1) * 60_000;
}

function id(value) {
  return `019f7400-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-schedule-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  const task = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision({
      projectId: 'default',
      taskId: 'task-1',
      expectedRevision: null,
      mutationId: '019f7410-0000-7000-8000-000000000001',
      name: 'Scheduled task',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: { kind: 'argv', file: '/bin/echo', args: ['scheduled'] },
        },
      },
      labels: {},
      enabled: true,
      occurredAtMs: 1,
    })
  ).definition;
  await runtime.triggers.appendTriggerRevision({
    projectId: 'default',
    triggerId: 'trigger-1',
    expectedRevision: null,
    mutationId: '019f7420-0000-7000-8000-000000000001',
    taskId: task.taskId,
    taskRevision: task.revision,
    taskContentDigest: task.contentDigest,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '* * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
    occurredAtMs: 1,
  });
  return runtime;
}

test('atomically advances one due Trigger into a queued Run aggregate', async (t) => {
  const runtime = await fixture(t);
  const page = await runtime.schedules.listLocalScheduleCandidates({
    observedAtMs: 61_000,
    limit: 4,
  });
  assert.equal(page.candidates.length, 1);
  assert.equal(page.truncated, false);
  assert.equal(page.candidates[0].nextFireAtMs, null);
  const decision = resolveLocalScheduleDecision(
    page.candidates[0],
    61_000,
    5_000,
    nextMinute,
  );
  const admitted = await runtime.schedules.commitLocalScheduleDecision({
    decision,
    runId: id(1),
    attemptId: id(2),
    createdEventId: id(3),
    queuedEventId: id(4),
  });
  assert.deepEqual(admitted, {
    status: 'admitted',
    disposition: 'admit',
    runId: id(1),
    attemptId: id(2),
  });
  const run = await runtime.runRepository.findRunById(id(1));
  assert.equal(run.status, 'queued');
  assert.equal(run.executionOwner, 'runtime');
  assert.equal(run.executionOrigin, 'scheduled_system');
  assert.equal(run.triggerId, 'trigger-1');
  assert.equal(run.scheduledForMs, 60_000);
  assert.match(run.taskRevision, /^qltd:v1:1:[a-f0-9]{64}$/);
  assert.equal(
    (await runtime.runRepository.findAttemptById(id(2))).status,
    'claimed',
  );
  assert.deepEqual(
    (await runtime.runRepository.listEvents(id(1))).map((event) => event.type),
    ['run.created', 'run.queued'],
  );
  assert.equal(
    (
      await runtime.schedules.listLocalScheduleCandidates({
        observedAtMs: 61_000,
        limit: 4,
      })
    ).candidates.length,
    0,
  );
  assert.deepEqual(
    await runtime.schedules.commitLocalScheduleDecision({
      decision,
      runId: id(5),
      attemptId: id(6),
      createdEventId: id(7),
      queuedEventId: id(8),
    }),
    { status: 'raced' },
  );
});

test('fences a stale Task head before schedule discovery and final Run commit', async (t) => {
  const runtime = await fixture(t);
  const page = await runtime.schedules.listLocalScheduleCandidates({
    observedAtMs: 61_000,
    limit: 4,
  });
  const decision = resolveLocalScheduleDecision(
    page.candidates[0],
    61_000,
    5_000,
    nextMinute,
  );
  const task = await runtime.taskDefinitions.findCurrentTaskDefinition(
    'default',
    'task-1',
  );
  const disabled = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision({
      projectId: task.projectId,
      taskId: task.taskId,
      expectedRevision: task.revision,
      mutationId: '019f7410-0000-7000-8000-000000000002',
      name: task.name,
      kind: task.kind,
      spec: task.spec,
      labels: task.labels,
      enabled: false,
      occurredAtMs: 2,
    })
  ).definition;

  assert.equal(
    (
      await runtime.schedules.listLocalScheduleCandidates({
        observedAtMs: 61_000,
        limit: 4,
      })
    ).candidates.length,
    0,
  );
  assert.deepEqual(
    await runtime.schedules.commitLocalScheduleDecision({
      decision,
      runId: id(21),
      attemptId: id(22),
      createdEventId: id(23),
      queuedEventId: id(24),
    }),
    { status: 'raced' },
  );
  assert.equal(await runtime.runRepository.findRunById(id(21)), null);

  await assert.rejects(
    runtime.triggers.appendTriggerRevision({
      projectId: 'default',
      triggerId: 'trigger-1',
      expectedRevision: 1,
      mutationId: '019f7420-0000-7000-8000-000000000002',
      taskId: task.taskId,
      taskRevision: task.revision,
      taskContentDigest: task.contentDigest,
      spec: {
        schema: 'qinglong/cron@v1',
        config: {
          expression: '* * * * *',
          timezone: 'UTC',
          misfirePolicy: 'skip',
        },
      },
      enabled: true,
      occurredAtMs: 3,
    }),
    { code: 'TRIGGER_CONFLICT' },
  );

  const enabled = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision({
      projectId: disabled.projectId,
      taskId: disabled.taskId,
      expectedRevision: disabled.revision,
      mutationId: '019f7410-0000-7000-8000-000000000003',
      name: disabled.name,
      kind: disabled.kind,
      spec: disabled.spec,
      labels: disabled.labels,
      enabled: true,
      occurredAtMs: 4,
    })
  ).definition;
  await runtime.triggers.appendTriggerRevision({
    projectId: 'default',
    triggerId: 'trigger-1',
    expectedRevision: 1,
    mutationId: '019f7420-0000-7000-8000-000000000003',
    taskId: enabled.taskId,
    taskRevision: enabled.revision,
    taskContentDigest: enabled.contentDigest,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '* * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
    occurredAtMs: 5,
  });
  assert.equal(
    (
      await runtime.schedules.listLocalScheduleCandidates({
        observedAtMs: 61_000,
        limit: 4,
      })
    ).candidates.length,
    1,
  );
});
