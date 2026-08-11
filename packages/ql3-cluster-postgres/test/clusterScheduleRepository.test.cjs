const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  resolveClusterScheduleDecision,
} = require('@qinglong/runtime-core/cluster-scheduler');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');
const {
  compileClusterCommandTaskDefinition,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
} = require('@qinglong/runtime-core/trigger');
const {
  PostgresClusterScheduleRepository,
  PostgresClusterScheduleUnavailableError,
} = require('../dist/scheduling/clusterScheduleRepository');

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  return Math.floor(afterMs / 60_000 + 1) * 60_000;
}

const CLAIM_TOKEN = '019f7700-0000-7000-8000-000000000001';
const TASK_COMMAND = Object.freeze({
  projectId: 'default',
  taskId: 'task-00001',
  expectedRevision: null,
  mutationId: '019f7700-0000-7000-8000-000000000010',
  name: 'Scheduled Task',
  kind: 'command',
  spec: Object.freeze({
    schema: 'qinglong/command@v1',
    config: Object.freeze({
      command: Object.freeze({
        kind: 'argv',
        file: '/bin/echo',
        args: Object.freeze(['scheduled']),
      }),
    }),
  }),
  labels: Object.freeze({}),
  enabled: true,
  occurredAtMs: 101,
});
const taskSemantics = createBuiltInTaskSpecSemanticRegistry();
const TASK = createTaskDefinitionRecord(
  Object.freeze({
    ...TASK_COMMAND,
    spec: taskSemantics.normalize({
      projectId: TASK_COMMAND.projectId,
      taskId: TASK_COMMAND.taskId,
      kind: TASK_COMMAND.kind,
      spec: TASK_COMMAND.spec,
    }),
  }),
  TASK_COMMAND.occurredAtMs,
);
const EXECUTION = compileClusterCommandTaskDefinition(TASK, taskSemantics);
const TRIGGER_COMMAND = Object.freeze({
  projectId: TASK.projectId,
  triggerId: 'trigger-00001',
  expectedRevision: null,
  mutationId: '019f7700-0000-7000-8000-000000000011',
  taskId: TASK.taskId,
  taskRevision: TASK.revision,
  taskContentDigest: TASK.contentDigest,
  spec: Object.freeze({
    schema: 'qinglong/cron@v1',
    config: Object.freeze({
      expression: '* * * * *',
      timezone: 'UTC',
      misfirePolicy: 'skip',
    }),
  }),
  enabled: true,
  occurredAtMs: 201,
});
const triggerSemantics = createBuiltInTriggerSpecSemanticRegistry();
const TRIGGER = createTriggerRecord(
  Object.freeze({
    ...TRIGGER_COMMAND,
    spec: triggerSemantics.normalize({
      projectId: TRIGGER_COMMAND.projectId,
      triggerId: TRIGGER_COMMAND.triggerId,
      taskId: TRIGGER_COMMAND.taskId,
      taskRevision: TRIGGER_COMMAND.taskRevision,
      spec: TRIGGER_COMMAND.spec,
    }),
  }),
  TRIGGER_COMMAND.occurredAtMs,
);

function claim(overrides = {}) {
  return {
    projectId: TRIGGER.projectId,
    triggerId: TRIGGER.triggerId,
    triggerRevision: TRIGGER.revision,
    triggerContentDigest: TRIGGER.contentDigest,
    triggerUpdatedAtMs: TRIGGER.updatedAtMs,
    taskId: TRIGGER.taskId,
    taskRevision: TRIGGER.taskRevision,
    taskContentDigest: TRIGGER.taskContentDigest,
    expression: TRIGGER.spec.config.expression,
    timezone: TRIGGER.spec.config.timezone,
    misfirePolicy: TRIGGER.spec.config.misfirePolicy,
    stateVersion: 1,
    nextFireAtMs: 60_000,
    claimOwner: 'scheduler-a',
    claimToken: CLAIM_TOKEN,
    claimVersion: 1,
    claimAcquiredAtMs: 61_000,
    claimExpiresAtMs: 91_000,
    ...overrides,
  };
}

function claimRow(overrides = {}) {
  const value = claim(overrides);
  return {
    projectId: value.projectId,
    triggerId: value.triggerId,
    triggerRevision: value.triggerRevision,
    triggerContentDigest: value.triggerContentDigest,
    triggerUpdatedAtMs: String(value.triggerUpdatedAtMs),
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    taskContentDigest: value.taskContentDigest,
    specJson: TRIGGER.spec,
    taskName: TASK.name,
    stateVersion: value.stateVersion,
    nextFireAtMs:
      value.nextFireAtMs === null ? null : String(value.nextFireAtMs),
    claimOwner: value.claimOwner,
    claimToken: value.claimToken,
    claimVersion: value.claimVersion,
    claimAcquiredAtMs: String(value.claimAcquiredAtMs),
    claimExpiresAtMs: String(value.claimExpiresAtMs),
    commitObservedAtMs: String(overrides.commitObservedAtMs ?? 62_000),
  };
}

function executionRow(overrides = {}) {
  return {
    projectId: EXECUTION.projectId,
    taskId: EXECUTION.taskId,
    sourceRevision: EXECUTION.sourceRevision,
    taskRevision: EXECUTION.taskRevision,
    sourceContentDigest: EXECUTION.sourceContentDigest,
    executorType: EXECUTION.executorType,
    planSchema: EXECUTION.planSchema,
    planJson: {
      command: EXECUTION.command,
      environment: EXECUTION.environment,
      ...(EXECUTION.workingDirectory === undefined
        ? {}
        : { workingDirectory: EXECUTION.workingDirectory }),
      ...(EXECUTION.timeoutMs === undefined
        ? {}
        : { timeoutMs: EXECUTION.timeoutMs }),
      ...(EXECUTION.placement === undefined
        ? {}
        : { placement: EXECUTION.placement }),
    },
    contentDigest: EXECUTION.contentDigest,
    createdAtMs: String(EXECUTION.createdAtMs),
    ...overrides,
  };
}

function fixture(options = {}) {
  const queries = [];
  let commitFailuresRemaining = options.failCommitOnce ? 1 : 0;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text === 'COMMIT' && commitFailuresRemaining > 0) {
        commitFailuresRemaining -= 1;
        const error = new Error('injected committed response loss');
        error.code = '40001';
        throw error;
      }
      if (text.includes('FOR UPDATE OF schedule')) {
        return {
          rows: options.missingClaim
            ? []
            : [
                claimRow({
                  ...options.claimOverrides,
                  commitObservedAtMs: options.commitObservedAtMs,
                }),
              ],
        };
      }
      if (text.includes('FROM "ql3"."task_execution_revisions"')) {
        return {
          rows: options.missingExecution
            ? []
            : [executionRow(options.executionOverrides)],
        };
      }
      if (
        options.failAt &&
        text.includes(`INSERT INTO "ql3"."${options.failAt}"`)
      ) {
        throw new Error('injected write failure');
      }
      if (text.includes('UPDATE "ql3"."trigger_schedules"')) {
        return { rows: [], rowCount: options.advanceRaced ? 0 : 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      queries.push({ text: 'RELEASE' });
    },
  };
  return {
    queries,
    pool: {
      async query(text, values) {
        queries.push({ text, values });
        return {
          rows: options.noDue ? [] : [claimRow(options.claimOverrides)],
        };
      },
      async connect() {
        return client;
      },
    },
  };
}

function admissionCommand(claimed = claim()) {
  return {
    claim: claimed,
    decision: resolveClusterScheduleDecision(claimed, 5_000, nextMinute),
    runId: '019f7700-0000-7000-8000-000000000020',
    attemptId: '019f7700-0000-7000-8000-000000000021',
    createdEventId: '019f7700-0000-7000-8000-000000000022',
    queuedEventId: '019f7700-0000-7000-8000-000000000023',
  };
}

test('claims one due schedule with ordered SKIP LOCKED lease takeover', async () => {
  const db = fixture();
  const repository = new PostgresClusterScheduleRepository(db.pool);
  assert.deepEqual(
    await repository.claimNextClusterSchedule({
      ownerId: 'scheduler-a',
      claimToken: CLAIM_TOKEN,
      leaseMs: 30_000,
    }),
    claim(),
  );
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].text, /FOR UPDATE OF schedule SKIP LOCKED/);
  assert.match(db.queries[0].text, /clock_timestamp\(\)/);
  assert.match(
    db.queries[0].text,
    /schedule\.claim_expires_at_ms <= observation\.observed_at_ms/,
  );
  assert.match(db.queries[0].text, /NULLS FIRST/);
  assert.match(
    db.queries[0].text,
    /task_head\.current_revision = task\.revision/,
  );
  assert.deepEqual(db.queries[0].values, ['scheduler-a', CLAIM_TOKEN, 30_000]);

  const empty = fixture({ noDue: true });
  assert.equal(
    await new PostgresClusterScheduleRepository(
      empty.pool,
    ).claimNextClusterSchedule({
      ownerId: 'scheduler-a',
      claimToken: CLAIM_TOKEN,
      leaseMs: 30_000,
    }),
    null,
  );
});

test('admits Run, Attempt and two events before advancing the exact claim', async () => {
  const db = fixture();
  const result = await new PostgresClusterScheduleRepository(
    db.pool,
  ).commitClusterScheduleDecision(admissionCommand());
  assert.deepEqual(result, {
    status: 'admitted',
    disposition: 'admit',
    runId: '019f7700-0000-7000-8000-000000000020',
    attemptId: '019f7700-0000-7000-8000-000000000021',
  });
  const sql = db.queries.map(({ text }) => text);
  assert.match(
    sql.find((text) => text.includes('FOR UPDATE OF schedule')),
    /task_head\.current_revision = task\.revision/,
  );
  const run = sql.findIndex((text) =>
    text.includes('INSERT INTO "ql3"."runs"'),
  );
  const attempt = sql.findIndex((text) =>
    text.includes('INSERT INTO "ql3"."run_attempts"'),
  );
  const events = sql.filter((text) =>
    text.includes('INSERT INTO "ql3"."run_events"'),
  );
  const advance = sql.findIndex((text) =>
    text.includes('UPDATE "ql3"."trigger_schedules"'),
  );
  assert.ok(
    run > 0 && attempt > run && events.length === 2 && advance > attempt,
  );
  assert.match(sql[attempt], /'remote_worker'/);
  assert.match(sql[advance], /claim_token = \$10::uuid/);
  assert.equal(
    db.queries
      .find(({ text }) => text.includes('INSERT INTO "ql3"."runs"'))
      .values.at(-1),
    62_000,
  );
  assert.equal(sql.includes('COMMIT'), true);
  assert.equal(sql.at(-1), 'RELEASE');
});

test('does not retry after COMMIT was sent and its response is lost', async () => {
  const db = fixture({ failCommitOnce: true });
  await assert.rejects(
    new PostgresClusterScheduleRepository(
      db.pool,
    ).commitClusterScheduleDecision(admissionCommand()),
    PostgresClusterScheduleUnavailableError,
  );
  const sql = db.queries.map(({ text }) => text);
  assert.equal(sql.filter((text) => text === 'COMMIT').length, 1);
  assert.equal(sql.includes('ROLLBACK'), false);
});

test('returns raced without writes when the durable claim fence changed', async () => {
  const db = fixture({ claimOverrides: { stateVersion: 2 } });
  assert.deepEqual(
    await new PostgresClusterScheduleRepository(
      db.pool,
    ).commitClusterScheduleDecision(admissionCommand()),
    { status: 'raced' },
  );
  const sql = db.queries.map(({ text }) => text);
  assert.equal(
    sql.some((text) => text.includes('INSERT INTO')),
    false,
  );
  assert.equal(sql.includes('ROLLBACK'), true);
});

test('uses the database commit clock for expiry and rejects clock regression', async () => {
  const expired = fixture({ commitObservedAtMs: 91_000 });
  assert.deepEqual(
    await new PostgresClusterScheduleRepository(
      expired.pool,
    ).commitClusterScheduleDecision(admissionCommand()),
    { status: 'raced' },
  );
  assert.equal(
    expired.queries.some(({ text }) => text.includes('INSERT INTO')),
    false,
  );

  const backwards = fixture({ commitObservedAtMs: 60_999 });
  await assert.rejects(
    new PostgresClusterScheduleRepository(
      backwards.pool,
    ).commitClusterScheduleDecision(admissionCommand()),
    /clock moved backwards/,
  );
  assert.equal(
    backwards.queries.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
});

test('advances a skipped occurrence without creating a Run', async () => {
  const claimed = claim({
    claimAcquiredAtMs: 900_000,
    claimExpiresAtMs: 930_000,
  });
  const db = fixture({
    claimOverrides: {
      claimAcquiredAtMs: 900_000,
      claimExpiresAtMs: 930_000,
    },
    commitObservedAtMs: 900_001,
  });
  const decision = resolveClusterScheduleDecision(claimed, 0, nextMinute);
  assert.equal(decision.disposition, 'skip');
  assert.deepEqual(
    await new PostgresClusterScheduleRepository(
      db.pool,
    ).commitClusterScheduleDecision({ claim: claimed, decision }),
    { status: 'advanced', disposition: 'skip' },
  );
  assert.equal(
    db.queries.some(({ text }) => text.includes('INSERT INTO "ql3"."runs"')),
    false,
  );
});

test('rolls back partial admission and rejects corrupt execution revisions', async () => {
  const failed = fixture({ failAt: 'run_attempts' });
  await assert.rejects(
    new PostgresClusterScheduleRepository(
      failed.pool,
    ).commitClusterScheduleDecision(admissionCommand()),
    PostgresClusterScheduleUnavailableError,
  );
  assert.equal(
    failed.queries.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
  assert.equal(
    failed.queries.some(({ text }) => text === 'COMMIT'),
    false,
  );

  const corrupt = fixture({
    executionOverrides: { contentDigest: 'f'.repeat(64) },
  });
  await assert.rejects(
    new PostgresClusterScheduleRepository(
      corrupt.pool,
    ).commitClusterScheduleDecision(admissionCommand()),
    PostgresClusterScheduleUnavailableError,
  );
  assert.equal(
    corrupt.queries.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
});
