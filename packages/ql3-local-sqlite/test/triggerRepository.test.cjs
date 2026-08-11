const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  TriggerConflictError,
  TriggerUnavailableError,
  UnsupportedTriggerSpecError,
  createTriggerSpecSemanticRegistry,
} = require('@qinglong/runtime-core/trigger');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-trigger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

function taskCommand(index, overrides = {}) {
  const suffix = String(index).padStart(12, '0');
  return {
    projectId: 'default',
    taskId: `task-${String(index).padStart(5, '0')}`,
    expectedRevision: null,
    mutationId: `019f7310-0000-7000-8000-${suffix}`,
    name: `Task ${index}`,
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: [String(index)] },
      },
    },
    labels: { source: 'trigger-test' },
    enabled: true,
    occurredAtMs: 100 + index,
    ...overrides,
  };
}

function triggerCommand(index, task, overrides = {}) {
  const suffix = String(index).padStart(12, '0');
  return {
    projectId: task.projectId,
    triggerId: `trigger-${String(index).padStart(5, '0')}`,
    expectedRevision: null,
    mutationId: `019f7320-0000-7000-8000-${suffix}`,
    taskId: task.taskId,
    taskRevision: task.revision,
    taskContentDigest: task.contentDigest,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '*/5 * * * *',
        timezone: 'Etc/UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
    occurredAtMs: 200 + index,
    ...overrides,
  };
}

async function createRuntime(t, options = {}) {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase(
    { databasePath, profile: 'edge' },
    options,
  );
  t.after(() => runtime.close());
  return { databasePath, runtime };
}

test('creates, replays and versions a Trigger pinned to immutable task revisions', async (t) => {
  const { runtime } = await createRuntime(t);
  const firstTask = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(taskCommand(1))
  ).definition;
  const firstInput = triggerCommand(1, firstTask);
  const created = await runtime.triggers.appendTriggerRevision(firstInput);
  assert.equal(created.status, 'created');
  assert.equal(created.trigger.revision, 1);
  assert.deepEqual({ ...created.trigger.spec.config }, {
    expression: '*/5 * * * *',
    misfirePolicy: 'skip',
    timezone: 'UTC',
  });
  assert.equal(
    (await runtime.triggers.appendTriggerRevision(firstInput)).status,
    'existing',
  );

  const secondTask = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(
      taskCommand(1, {
        expectedRevision: 1,
        mutationId: '019f7310-0000-7000-8000-000000010001',
        name: 'Task 1 revision 2',
        occurredAtMs: 300,
      }),
    )
  ).definition;
  const updated = await runtime.triggers.appendTriggerRevision(
    triggerCommand(1, secondTask, {
      expectedRevision: 1,
      mutationId: '019f7320-0000-7000-8000-000000010001',
      occurredAtMs: 400,
    }),
  );
  assert.equal(updated.status, 'updated');
  assert.equal(updated.trigger.taskRevision, 2);
  assert.equal(updated.trigger.createdAtMs, created.trigger.createdAtMs);
  assert.equal(
    (
      await runtime.triggers.findTriggerRevision(
        'default',
        firstInput.triggerId,
        1,
      )
    ).taskRevision,
    1,
  );
  assert.equal(
    (
      await runtime.triggers.findCurrentTrigger(
        'default',
        firstInput.triggerId,
      )
    ).taskRevision,
    2,
  );
});

test('rejects digest drift, disabled targets, stale CAS and task rebinding', async (t) => {
  const { runtime } = await createRuntime(t);
  const task1 = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(taskCommand(1))
  ).definition;
  await assert.rejects(
    runtime.triggers.appendTriggerRevision(
      triggerCommand(1, task1, { taskContentDigest: 'b'.repeat(64) }),
    ),
    TriggerConflictError,
  );

  const disabledTask = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(
      taskCommand(2, { enabled: false }),
    )
  ).definition;
  await assert.rejects(
    runtime.triggers.appendTriggerRevision(triggerCommand(2, disabledTask)),
    TriggerConflictError,
  );
  const disabledTrigger = await runtime.triggers.appendTriggerRevision(
    triggerCommand(2, disabledTask, {
      enabled: false,
      mutationId: '019f7320-0000-7000-8000-000000020001',
    }),
  );
  assert.equal(disabledTrigger.trigger.enabled, false);

  const first = await runtime.triggers.appendTriggerRevision(
    triggerCommand(1, task1),
  );
  await assert.rejects(
    runtime.triggers.appendTriggerRevision(
      triggerCommand(1, task1, {
        expectedRevision: null,
        mutationId: '019f7320-0000-7000-8000-000000010010',
      }),
    ),
    TriggerConflictError,
  );
  await assert.rejects(
    runtime.triggers.appendTriggerRevision(
      triggerCommand(1, disabledTask, {
        enabled: false,
        expectedRevision: first.trigger.revision,
        mutationId: '019f7320-0000-7000-8000-000000010011',
        occurredAtMs: 500,
      }),
    ),
    TriggerConflictError,
  );
});

test('paginates current Trigger heads and serializes competing revisions', async (t) => {
  const { runtime } = await createRuntime(t);
  const task = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(taskCommand(1))
  ).definition;
  for (const index of [1, 2, 3]) {
    await runtime.triggers.appendTriggerRevision(triggerCommand(index, task));
  }
  const first = await runtime.triggers.listTriggers({
    projectId: 'default',
    limit: 2,
  });
  assert.equal(first.triggers.length, 2);
  assert.equal(first.truncated, true);
  const second = await runtime.triggers.listTriggers({
    projectId: 'default',
    limit: 2,
    after: first.next,
  });
  assert.equal(second.triggers.length, 1);
  assert.equal(second.truncated, false);

  const base = first.triggers[0];
  const results = await Promise.allSettled([
    runtime.triggers.appendTriggerRevision(
      triggerCommand(1, task, {
        expectedRevision: base.revision,
        mutationId: '019f7320-0000-7000-8000-000000010101',
        occurredAtMs: 600,
      }),
    ),
    runtime.triggers.appendTriggerRevision(
      triggerCommand(1, task, {
        expectedRevision: base.revision,
        mutationId: '019f7320-0000-7000-8000-000000010102',
        occurredAtMs: 601,
      }),
    ),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
});

test('fails closed when a durable Trigger or pinned task digest is corrupt', async (t) => {
  const { databasePath, runtime } = await createRuntime(t);
  const task = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(taskCommand(1))
  ).definition;
  const input = triggerCommand(1, task);
  const trigger = (
    await runtime.triggers.appendTriggerRevision(input)
  ).trigger;
  await runtime.close();

  const client = new DatabaseSync(databasePath);
  client
    .prepare(
      `UPDATE "QingLong3TriggerRevisions" SET "content_digest" = ?
       WHERE "project_id" = ? AND "trigger_id" = ? AND "revision" = ?`,
    )
    .run('b'.repeat(64), trigger.projectId, trigger.triggerId, trigger.revision);
  client.close();
  const reader = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => reader.close());
  await assert.rejects(
    reader.triggers.findCurrentTrigger(trigger.projectId, trigger.triggerId),
    TriggerUnavailableError,
  );
  await reader.close();

  const taskClient = new DatabaseSync(databasePath);
  taskClient
    .prepare(
      `UPDATE "QingLong3TriggerRevisions" SET "content_digest" = ?
       WHERE "project_id" = ? AND "trigger_id" = ? AND "revision" = ?`,
    )
    .run(
      trigger.contentDigest,
      trigger.projectId,
      trigger.triggerId,
      trigger.revision,
    );
  taskClient
    .prepare(
      `UPDATE "QingLong3TaskDefinitionRevisions" SET "content_digest" = ?
       WHERE "project_id" = ? AND "task_id" = ? AND "revision" = ?`,
    )
    .run('b'.repeat(64), task.projectId, task.taskId, task.revision);
  taskClient.close();
  const replayReader = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => replayReader.close());
  await assert.rejects(
    replayReader.triggers.appendTriggerRevision(input),
    TriggerUnavailableError,
  );
});

test('reads historical extension specs without loading their write semantics', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const registry = createTriggerSpecSemanticRegistry([
    {
      schema: 'example/event@v1',
      normalizeConfig(config) {
        return Object.freeze({ topic: String(config.topic).toLowerCase() });
      },
    },
  ]);
  const writer = await openLocalSqliteRuntimeDatabase(
    { databasePath, profile: 'edge' },
    { triggerSpecSemanticRegistry: registry },
  );
  const task = (
    await writer.taskDefinitions.appendTaskDefinitionRevision(taskCommand(1))
  ).definition;
  const input = triggerCommand(1, task, {
    spec: { schema: 'example/event@v1', config: { topic: 'BUILD' } },
  });
  await writer.triggers.appendTriggerRevision(input);
  await writer.close();

  const reader = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => reader.close());
  assert.equal(
    (
      await reader.triggers.findCurrentTrigger(
        input.projectId,
        input.triggerId,
      )
    ).spec.config.topic,
    'build',
  );
  await assert.rejects(
    async () => reader.triggers.appendTriggerRevision(input),
    UnsupportedTriggerSpecError,
  );
});
