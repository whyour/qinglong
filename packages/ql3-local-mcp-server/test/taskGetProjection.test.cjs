const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  BUILTIN_TASK_GET_TOOL_DEFINITION,
  BuiltInTaskGetToolUnavailableError,
  InvalidBuiltInTaskGetToolError,
  executeBuiltInTaskGetTool,
} = require('../dist/tool-projection/taskGet.js');

function task(overrides = {}) {
  return createTaskDefinitionRecord(
    {
      projectId: 'default',
      taskId: 'task-1',
      expectedRevision: 1,
      mutationId: '123e4567-e89b-42d3-a456-426614174301',
      name: 'Example Task',
      description: 'private description',
      kind: 'script',
      spec: {
        schema: 'qinglong/script@v1',
        config: { command: 'private command' },
      },
      labels: { private: 'label' },
      enabled: true,
      occurredAtMs: 20,
      ...overrides,
    },
    10,
  );
}

test('defines an exact low-risk task.read Tool', () => {
  assert.equal(BUILTIN_TASK_GET_TOOL_DEFINITION.name, 'qinglong.task.get');
  assert.equal(BUILTIN_TASK_GET_TOOL_DEFINITION.version, '1.0.0');
  assert.equal(BUILTIN_TASK_GET_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_TASK_GET_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_TASK_GET_TOOL_DEFINITION.requiredPermissions, [
    'task.read',
  ]);
});

test('reads one current Task and omits private definition fields', async () => {
  const definition = task({ enabled: false });
  let captured;
  const output = await executeBuiltInTaskGetTool(
    {
      async findCurrentTaskDefinition(projectId, taskId) {
        captured = [projectId, taskId];
        return definition;
      },
    },
    'default',
    { taskId: 'task-1' },
  );
  assert.deepEqual(captured, ['default', 'task-1']);
  assert.deepEqual(output, {
    found: true,
    taskId: 'task-1',
    revision: 2,
    name: 'Example Task',
    kind: 'script',
    specSchema: 'qinglong/script@v1',
    enabled: false,
    contentDigest: definition.contentDigest,
    createdAtMs: 10,
    updatedAtMs: 20,
  });
  const serialized = JSON.stringify(output);
  for (const hidden of [
    'private description',
    'private command',
    'private',
    'mutationId',
  ]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test('masks absence and maps invalid or unavailable reads', async () => {
  assert.deepEqual(
    await executeBuiltInTaskGetTool(
      { async findCurrentTaskDefinition() { return null; } },
      'default',
      { taskId: 'task-absent' },
    ),
    { found: false },
  );
  await assert.rejects(
    executeBuiltInTaskGetTool(
      { async findCurrentTaskDefinition() { return null; } },
      'default',
      { taskId: '', extra: true },
    ),
    InvalidBuiltInTaskGetToolError,
  );
  await assert.rejects(
    executeBuiltInTaskGetTool(
      { async findCurrentTaskDefinition() { throw new Error('offline'); } },
      'default',
      { taskId: 'task-1' },
    ),
    BuiltInTaskGetToolUnavailableError,
  );
});
