const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createLocalApiTaskReadRoute,
} = require('../dist/task/taskReadRoute.js');

function task(overrides = {}) {
  return createTaskDefinitionRecord(
    {
      projectId: 'prj_default',
      taskId: 'task-a',
      expectedRevision: null,
      mutationId: '123e4567-e89b-42d3-a456-426614174101',
      name: 'Task A',
      description: 'secret-adjacent',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: { command: { kind: 'shell', command: 'private' } },
      },
      labels: { private: 'value' },
      enabled: true,
      occurredAtMs: 20,
      ...overrides,
    },
    10,
  );
}

test('returns one shared current Task projection without definition internals', async () => {
  const calls = [];
  const definition = task({ enabled: false });
  const route = createLocalApiTaskReadRoute({
    async findCurrentTaskDefinition(projectId, taskId) {
      calls.push([projectId, taskId]);
      return definition;
    },
  });
  const response = await route.handle({
    projectId: 'prj_default',
    taskId: 'task-a',
  });
  assert.deepEqual(calls, [['prj_default', 'task-a']]);
  assert.deepEqual(response, {
    statusCode: 200,
    body: {
      task: {
        taskId: 'task-a',
        revision: 1,
        name: 'Task A',
        kind: 'command',
        specSchema: 'qinglong/command@v1',
        enabled: false,
        contentDigest: definition.contentDigest,
        createdAtMs: 10,
        updatedAtMs: 20,
      },
    },
  });
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes('secret-adjacent'), false);
  assert.equal(serialized.includes('private'), false);
});

test('masks absence and Project mismatch and fails closed on corruption', async () => {
  for (const value of [null, task({ projectId: 'prj_other' })]) {
    const route = createLocalApiTaskReadRoute({
      async findCurrentTaskDefinition() { return value; },
    });
    assert.deepEqual(
      await route.handle({ projectId: 'prj_default', taskId: 'task-a' }),
      { statusCode: 404, body: { code: 'task_not_found' } },
    );
  }
  const corrupt = task();
  const route = createLocalApiTaskReadRoute({
    async findCurrentTaskDefinition() {
      return { ...corrupt, contentDigest: '0'.repeat(64) };
    },
  });
  assert.deepEqual(
    await route.handle({ projectId: 'prj_default', taskId: 'task-a' }),
    { statusCode: 503, body: { code: 'task_query_unavailable' } },
  );
  assert.throws(() => createLocalApiTaskReadRoute({}), TypeError);
});
