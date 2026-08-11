const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const ownerCliRequire = createRequire(
  require.resolve('../../packages/ql3-local-owner-cli/package.json'),
);
const localSqliteRequire = createRequire(
  require.resolve('../../packages/ql3-local-sqlite/package.json'),
);
const localExecutionRequire = createRequire(
  require.resolve('../../packages/ql3-local-execution/package.json'),
);
const { runLocalTaskDefinitionCommandFile } = ownerCliRequire(
  '@qinglong/local-owner-cli/task-definition-command',
);
const { runLocalTriggerCommandFile } = ownerCliRequire(
  '@qinglong/local-owner-cli/trigger-command',
);
const { openLocalSqliteRuntimeDatabase } = localSqliteRequire(
  '@qinglong/local-sqlite/runtime',
);
const { LocalSchedulerCoordinator } = localExecutionRequire(
  '@qinglong/local-execution/scheduler',
);
const {
  localManagementFixture,
  taskPutRequest,
  writeCommand,
} = require('../../packages/ql3-local-owner-cli/test/localManagementFixture.cjs');

function triggerRequest(value, task, overrides = {}) {
  return {
    projectId: 'default',
    triggerId: 'fresh-product-trigger',
    expectedRevision: null,
    mutationId: 'a1000000-0000-4000-8000-000000000001',
    requestId: 'fresh-trigger-put-1',
    failureAuditEventId: 'a2000000-0000-4000-8000-000000000001',
    taskId: task.taskId,
    taskRevision: task.revision,
    taskContentDigest: task.contentDigest,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '* * * * *',
        timezone: 'UTC',
        misfirePolicy: 'fire_once',
      },
    },
    enabled: true,
    occurredAtMs: value.now + 1,
    ...overrides,
  };
}

test('fresh product commands create Task then Trigger then one scheduled Run', async (t) => {
  const value = await localManagementFixture(t);
  const taskCreate = taskPutRequest(value, '1', {
    taskId: 'fresh-product-task',
  });
  const task = (
    await runLocalTaskDefinitionCommandFile(
      writeCommand(value, 'task.put', taskCreate, 'fresh-task-create'),
    )
  ).task;
  const triggerCreate = triggerRequest(value, task);
  const trigger = (
    await runLocalTriggerCommandFile(
      writeCommand(value, 'trigger.put', triggerCreate, 'fresh-trigger-create'),
    )
  ).trigger;
  assert.equal(trigger.taskContentDigest, task.contentDigest);

  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  const clockValues = [value.now + 1, value.now + 2_000, value.now + 4_000];
  const ids = [
    'a3000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000003',
    'a3000000-0000-4000-8000-000000000004',
  ];
  const scheduler = new LocalSchedulerCoordinator(runtime.schedules, {
    pageSize: 4,
    misfireGraceMs: 5_000,
    clock: () => clockValues.shift(),
    createId: () => ids.shift(),
    nextOccurrence: (_schedule, afterMs) => afterMs + 1_000,
  });
  assert.equal((await scheduler.scheduleOnce()).initialized, 1);
  const admitted = await scheduler.scheduleOnce();
  assert.equal(admitted.admitted, 1);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const run = database
      .prepare(
        `SELECT id, task_id AS "taskId", trigger_id AS "triggerId", status
         FROM "Runs"`,
      )
      .get();
    assert.deepEqual(
      { ...run },
      {
        id: 'a3000000-0000-4000-8000-000000000001',
        taskId: task.taskId,
        triggerId: trigger.triggerId,
        status: 'queued',
      },
    );
  } finally {
    database.close();
  }

  await runLocalTaskDefinitionCommandFile(
    writeCommand(
      value,
      'task.put',
      taskPutRequest(value, '2', {
        taskId: task.taskId,
        expectedRevision: 1,
        mutationId: 'a4000000-0000-4000-8000-000000000001',
        requestId: 'fresh-task-disable-1',
        failureAuditEventId: 'a5000000-0000-4000-8000-000000000001',
        enabled: false,
        occurredAtMs: value.now + 3_000,
      }),
      'fresh-task-disable',
    ),
  );
  const afterTaskDisable = await scheduler.scheduleOnce();
  assert.equal(afterTaskDisable.scanned, 0);

  const disabledTrigger = await runLocalTriggerCommandFile(
    writeCommand(
      value,
      'trigger.put',
      triggerRequest(value, task, {
        expectedRevision: 1,
        mutationId: 'a6000000-0000-4000-8000-000000000001',
        requestId: 'fresh-trigger-disable-1',
        failureAuditEventId: 'a7000000-0000-4000-8000-000000000001',
        enabled: false,
        occurredAtMs: value.now + 4_000,
      }),
      'fresh-trigger-disable',
    ),
  );
  assert.equal(disabledTrigger.trigger.enabled, false);
  assert.equal(disabledTrigger.trigger.revision, 2);

  const finalDatabase = new DatabaseSync(value.databasePath, {
    readOnly: true,
  });
  try {
    assert.equal(
      finalDatabase.prepare('SELECT COUNT(*) AS count FROM "Runs"').get().count,
      1,
    );
  } finally {
    finalDatabase.close();
  }
});
