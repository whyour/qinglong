const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  createTaskDefinitionRecord,
  TaskDefinitionConflictError,
  TaskDefinitionUnavailableError,
} = require('@qinglong/runtime-core/task-definition');
const {
  UnsupportedTaskSpecError,
  createBuiltInTaskSpecSemanticRegistry,
  createTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');
const {
  compileLocalCommandTaskDefinition,
} = require('@qinglong/runtime-core/task-definition-execution-compiler');
const {
  createLocalTaskExecutionRevision,
} = require('@qinglong/runtime-core/local-dispatch');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-task-def-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

function command(index, overrides = {}) {
  const suffix = String(index).padStart(12, '0');
  return {
    projectId: 'default',
    taskId: `task-${String(index).padStart(5, '0')}`,
    expectedRevision: null,
    mutationId: `019f7200-0000-7000-8000-${suffix}`,
    name: `Task ${index}`,
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: [String(index)] },
      },
    },
    labels: { source: 'contract-test' },
    enabled: true,
    occurredAtMs: 100 + index,
    ...overrides,
  };
}

test('creates, versions and resolves immutable TaskDefinitions', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());

  const created = await runtime.taskDefinitions.appendTaskDefinitionRevision(
    command(1),
  );
  assert.equal(created.status, 'created');
  assert.equal(created.definition.revision, 1);
  const createdTaskRevision = `qltd:v1:1:${created.definition.contentDigest}`;
  const executionRevision =
    await runtime.localDispatch.resolveLocalTaskExecutionRevision({
      projectId: created.definition.projectId,
      taskId: created.definition.taskId,
      taskRevision: createdTaskRevision,
    });
  assert.ok(executionRevision);
  assert.match(executionRevision.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await runtime.localDispatch.resolveLocalExecutionContextRecipe(
        executionRevision.contextRef,
      )
    ).contextRef,
    executionRevision.contextRef,
  );
  assert.equal(
    (await runtime.taskDefinitions.appendTaskDefinitionRevision(command(1)))
      .status,
    'existing',
  );

  const updatedCommand = command(1, {
    expectedRevision: 1,
    mutationId: '019f7200-0000-7000-8000-000000010001',
    name: 'Task 1 updated',
    enabled: false,
    occurredAtMs: 200,
  });
  const updated = await runtime.taskDefinitions.appendTaskDefinitionRevision(
    updatedCommand,
  );
  assert.equal(updated.status, 'updated');
  assert.equal(updated.definition.revision, 2);
  assert.equal(updated.definition.createdAtMs, 101);
  assert.equal(updated.definition.updatedAtMs, 200);
  assert.equal(
    await runtime.localDispatch.resolveLocalTaskExecutionRevision({
      projectId: updated.definition.projectId,
      taskId: updated.definition.taskId,
      taskRevision: `qltd:v1:2:${updated.definition.contentDigest}`,
    }),
    null,
  );
  assert.equal(
    (
      await runtime.taskDefinitions.findCurrentTaskDefinition(
        'default',
        'task-00001',
      )
    ).name,
    'Task 1 updated',
  );
  assert.equal(
    (
      await runtime.taskDefinitions.findTaskDefinitionRevision(
        'default',
        'task-00001',
        1,
      )
    ).name,
    'Task 1',
  );
});

test('rejects unknown semantics before mutation and accepts explicit composition', async (t) => {
  const builtInPath = fixture(t);
  await migrateLocalSqlitePath({ databasePath: builtInPath, profile: 'edge' });
  const builtIn = await openLocalSqliteRuntimeDatabase({
    databasePath: builtInPath,
    profile: 'edge',
  });
  t.after(() => builtIn.close());
  const customCommand = command(1, {
    kind: 'tool',
    spec: { schema: 'example/tool@v1', config: { entrypoint: 'probe' } },
  });
  await assert.rejects(
    async () =>
      builtIn.taskDefinitions.appendTaskDefinitionRevision(customCommand),
    UnsupportedTaskSpecError,
  );
  assert.equal(
    await builtIn.taskDefinitions.findCurrentTaskDefinition(
      customCommand.projectId,
      customCommand.taskId,
    ),
    null,
  );

  const customPath = fixture(t);
  await migrateLocalSqlitePath({ databasePath: customPath, profile: 'edge' });
  const registry = createTaskSpecSemanticRegistry([
    {
      schema: 'example/tool@v1',
      kind: 'tool',
      normalizeConfig(config) {
        return Object.freeze({
          entrypoint: String(config.entrypoint).toUpperCase(),
        });
      },
    },
  ]);
  const custom = await openLocalSqliteRuntimeDatabase(
    { databasePath: customPath, profile: 'edge' },
    { taskSpecSemanticRegistry: registry },
  );
  t.after(() => custom.close());
  const created = await custom.taskDefinitions.appendTaskDefinitionRevision(
    customCommand,
  );
  assert.equal(created.status, 'created');
  assert.equal(created.definition.spec.config.entrypoint, 'PROBE');

  await custom.close();
  const historicalReader = await openLocalSqliteRuntimeDatabase({
    databasePath: customPath,
    profile: 'edge',
  });
  t.after(() => historicalReader.close());
  assert.equal(
    (
      await historicalReader.taskDefinitions.findCurrentTaskDefinition(
        customCommand.projectId,
        customCommand.taskId,
      )
    ).spec.config.entrypoint,
    'PROBE',
  );
  await assert.rejects(
    async () =>
      historicalReader.taskDefinitions.appendTaskDefinitionRevision(
        customCommand,
      ),
    UnsupportedTaskSpecError,
  );
});

test('publishes TaskDefinition and local execution facts in one transaction', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());

  const input = command(20);
  const registry = createBuiltInTaskSpecSemanticRegistry();
  const canonicalInput = {
    ...input,
    spec: registry.normalize({
      projectId: input.projectId,
      taskId: input.taskId,
      kind: input.kind,
      spec: input.spec,
    }),
  };
  const definition = createTaskDefinitionRecord(
    canonicalInput,
    input.occurredAtMs,
  );
  const plan = compileLocalCommandTaskDefinition(definition, registry);
  assert.equal(
    await runtime.localDispatch.appendLocalExecutionContextRecipe(
      plan.contextRecipe,
    ),
    'inserted',
  );
  const conflictingRevision = createLocalTaskExecutionRevision({
    ...plan.executionRevision,
    command: { kind: 'argv', file: '/bin/echo', args: ['conflict'] },
  });
  assert.equal(
    await runtime.localDispatch.appendLocalTaskExecutionRevision(
      conflictingRevision,
    ),
    'inserted',
  );

  await assert.rejects(
    runtime.taskDefinitions.appendTaskDefinitionRevision(input),
    TaskDefinitionConflictError,
  );
  assert.equal(
    await runtime.taskDefinitions.findCurrentTaskDefinition(
      input.projectId,
      input.taskId,
    ),
    null,
  );
  const client = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      client
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "QingLong3TaskDefinitionRevisions"
           WHERE "project_id" = ? AND "task_id" = ?`,
        )
        .get(input.projectId, input.taskId).count,
      0,
    );
  } finally {
    client.close();
  }
});

test('exact TaskDefinition replay fails closed when a published execution fact is missing', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  const input = command(21);
  const created = await runtime.taskDefinitions.appendTaskDefinitionRevision(
    input,
  );
  const taskRevision = `qltd:v1:1:${created.definition.contentDigest}`;
  const client = new DatabaseSync(databasePath);
  try {
    client
      .prepare(
        `DELETE FROM "QingLong3LocalTaskExecutionRevisions"
         WHERE "project_id" = ? AND "task_id" = ? AND "task_revision" = ?`,
      )
      .run(input.projectId, input.taskId, taskRevision);
  } finally {
    client.close();
  }

  await assert.rejects(
    runtime.taskDefinitions.appendTaskDefinitionRevision(input),
    TaskDefinitionUnavailableError,
  );
  assert.equal(
    await runtime.localDispatch.resolveLocalTaskExecutionRevision({
      projectId: input.projectId,
      taskId: input.taskId,
      taskRevision,
    }),
    null,
  );
});

test('fences stale revisions, mutation drift and archived Projects', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  await runtime.taskDefinitions.appendTaskDefinitionRevision(command(1));

  await assert.rejects(
    runtime.taskDefinitions.appendTaskDefinitionRevision(
      command(1, { name: 'drifted replay' }),
    ),
    TaskDefinitionConflictError,
  );
  await assert.rejects(
    runtime.taskDefinitions.appendTaskDefinitionRevision(
      command(1, {
        expectedRevision: 2,
        mutationId: '019f7200-0000-7000-8000-000000010002',
      }),
    ),
    TaskDefinitionConflictError,
  );

  const client = new DatabaseSync(databasePath);
  client.exec(
    `UPDATE "QingLong3Projects" SET "status" = 'archived', "version" = 2,
       "updated_at_ms" = 300 WHERE "id" = 'default'`,
  );
  client.close();
  await assert.rejects(
    runtime.taskDefinitions.appendTaskDefinitionRevision(command(2)),
    TaskDefinitionConflictError,
  );
});

test('paginates current definitions and allows only one concurrent revision', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'standalone' });
  const first = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'standalone',
  });
  const second = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'standalone',
  });
  t.after(() => Promise.all([first.close(), second.close()]));
  for (let index = 1; index <= 3; index += 1) {
    await first.taskDefinitions.appendTaskDefinitionRevision(command(index));
  }
  const page = await first.taskDefinitions.listTaskDefinitions({
    projectId: 'default',
    limit: 2,
  });
  assert.deepEqual(
    page.definitions.map(({ taskId }) => taskId),
    ['task-00001', 'task-00002'],
  );
  assert.equal(page.truncated, true);
  assert.deepEqual(
    (
      await first.taskDefinitions.listTaskDefinitions({
        projectId: 'default',
        limit: 2,
        after: page.next,
      })
    ).definitions.map(({ taskId }) => taskId),
    ['task-00003'],
  );

  const results = await Promise.allSettled([
    first.taskDefinitions.appendTaskDefinitionRevision(
      command(1, {
        expectedRevision: 1,
        mutationId: '019f7200-0000-7000-8000-000000020001',
        name: 'winner-a',
        occurredAtMs: 500,
      }),
    ),
    second.taskDefinitions.appendTaskDefinitionRevision(
      command(1, {
        expectedRevision: 1,
        mutationId: '019f7200-0000-7000-8000-000000020002',
        name: 'winner-b',
        occurredAtMs: 500,
      }),
    ),
  ]);
  assert.equal(
    results.filter(({ status }) => status === 'fulfilled').length,
    1,
  );
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.ok(
    results.find(({ status }) => status === 'rejected').reason instanceof
      TaskDefinitionConflictError,
  );
});

test('fails closed when a durable revision digest is corrupt', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  await runtime.taskDefinitions.appendTaskDefinitionRevision(command(1));
  const client = new DatabaseSync(databasePath);
  client.exec(
    `UPDATE "QingLong3TaskDefinitionRevisions"
     SET "content_digest" = '${'0'.repeat(64)}'`,
  );
  client.close();
  await assert.rejects(
    runtime.taskDefinitions.findCurrentTaskDefinition('default', 'task-00001'),
    TaskDefinitionUnavailableError,
  );
});

test('fails closed when a durable execution revision digest is corrupt', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  const input = command(22);
  const created = await runtime.taskDefinitions.appendTaskDefinitionRevision(
    input,
  );
  const taskRevision = `qltd:v1:1:${created.definition.contentDigest}`;
  const client = new DatabaseSync(databasePath);
  client
    .prepare(
      `UPDATE "QingLong3LocalTaskExecutionRevisions"
       SET "content_digest" = ?
       WHERE "project_id" = ? AND "task_id" = ? AND "task_revision" = ?`,
    )
    .run('0'.repeat(64), input.projectId, input.taskId, taskRevision);
  client.close();
  await assert.rejects(
    runtime.localDispatch.resolveLocalTaskExecutionRevision({
      projectId: input.projectId,
      taskId: input.taskId,
      taskRevision,
    }),
    /digest does not match/,
  );
  await assert.rejects(
    runtime.taskDefinitions.appendTaskDefinitionRevision(input),
    TaskDefinitionUnavailableError,
  );
});
