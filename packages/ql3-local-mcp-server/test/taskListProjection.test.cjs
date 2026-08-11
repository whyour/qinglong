const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_TASK_LIST_TOOL_DEFINITION,
  BuiltInTaskListToolUnavailableError,
  InvalidBuiltInTaskListToolError,
  executeBuiltInTaskListTool,
} = require('../dist/tool-projection/taskList.js');

function definition(taskId, overrides = {}) {
  return Object.freeze({
    projectId: 'default',
    taskId,
    revision: 2,
    mutationId: 'private-mutation',
    name: `Task ${taskId}`,
    description: 'private description',
    kind: 'script',
    spec: Object.freeze({
      schema: 'qinglong/script@v1',
      config: Object.freeze({ command: 'private command' }),
    }),
    labels: Object.freeze({ private: 'label' }),
    enabled: true,
    contentDigest: 'private-digest',
    createdAtMs: 10,
    updatedAtMs: 20,
    ...overrides,
  });
}

test('defines an exact low-risk task.read Tool', () => {
  assert.equal(BUILTIN_TASK_LIST_TOOL_DEFINITION.name, 'qinglong.task.list');
  assert.equal(BUILTIN_TASK_LIST_TOOL_DEFINITION.version, '1.0.0');
  assert.equal(BUILTIN_TASK_LIST_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_TASK_LIST_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_TASK_LIST_TOOL_DEFINITION.requiredPermissions, [
    'task.read',
  ]);
});

test('projects bounded current Tasks without private definition fields', async () => {
  let captured;
  const output = await executeBuiltInTaskListTool(
    {
      async listTaskDefinitions(query) {
        captured = query;
        return Object.freeze({
          definitions: Object.freeze([definition('task-b')]),
          truncated: true,
          next: Object.freeze({ taskId: 'task-b' }),
        });
      },
    },
    'default',
    { after: { taskId: 'task-a' }, limit: 1 },
  );
  assert.deepEqual(captured, {
    projectId: 'default',
    limit: 1,
    after: { taskId: 'task-a' },
  });
  assert.deepEqual(output, {
    tasks: [
      {
        taskId: 'task-b',
        revision: 2,
        name: 'Task task-b',
        kind: 'script',
        specSchema: 'qinglong/script@v1',
        enabled: true,
        updatedAtMs: 20,
      },
    ],
    hasMore: true,
    next: { taskId: 'task-b' },
  });
  const serialized = JSON.stringify(output);
  for (const hidden of [
    'private-mutation',
    'private description',
    'private command',
    'private-digest',
    'label',
  ]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test('defaults to 32 and returns no cursor for a complete page', async () => {
  let captured;
  const output = await executeBuiltInTaskListTool(
    {
      async listTaskDefinitions(query) {
        captured = query;
        return { definitions: [], truncated: false };
      },
    },
    'default',
    {},
  );
  assert.deepEqual(captured, { projectId: 'default', limit: 32 });
  assert.deepEqual(output, { tasks: [], hasMore: false });
});

test('rejects invalid input before reading', async () => {
  let reads = 0;
  const source = {
    async listTaskDefinitions() {
      reads += 1;
      return { definitions: [], truncated: false };
    },
  };
  await assert.rejects(
    executeBuiltInTaskListTool(source, 'default', { limit: 65 }),
    InvalidBuiltInTaskListToolError,
  );
  await assert.rejects(
    executeBuiltInTaskListTool(source, 'default', { after: { taskId: '' } }),
    InvalidBuiltInTaskListToolError,
  );
  assert.equal(reads, 0);
});

test('fails closed on cross-Project, unordered, oversized or inconsistent pages', async () => {
  for (const page of [
    {
      definitions: [definition('task-a', { projectId: 'other' })],
      truncated: false,
    },
    {
      definitions: [definition('task-b'), definition('task-a')],
      truncated: false,
    },
    {
      definitions: [definition('task-a'), definition('task-b')],
      truncated: false,
    },
    { definitions: [definition('task-a')], truncated: true },
    {
      definitions: [definition('task-a')],
      truncated: true,
      next: { taskId: 'other' },
    },
  ]) {
    await assert.rejects(
      executeBuiltInTaskListTool(
        {
          async listTaskDefinitions() {
            return page;
          },
        },
        'default',
        page.definitions.length === 2 && page.definitions[0].taskId === 'task-a'
          ? { limit: 1 }
          : {},
      ),
      BuiltInTaskListToolUnavailableError,
    );
  }
});
