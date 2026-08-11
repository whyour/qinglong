const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createLocalApiTaskListRoute,
} = require('../dist/task/taskListRoute.js');

function task(taskId, overrides = {}) {
  return {
    projectId: 'prj_default',
    taskId,
    revision: 2,
    name: `Task ${taskId}`,
    description: 'secret-adjacent',
    kind: 'command',
    spec: { schema: 'qinglong/command@v1', config: { command: ['private'] } },
    labels: { private: 'value' },
    enabled: true,
    mutationId: 'mutation-private',
    contentDigest: 'digest-private',
    createdAtMs: 10,
    updatedAtMs: 20,
    ...overrides,
  };
}

test('returns the shared bounded Project Task list projection', async () => {
  const calls = [];
  const route = createLocalApiTaskListRoute({
    async listTaskDefinitions(query) {
      calls.push(query);
      return {
        definitions: [task('task-a', { enabled: false })],
        truncated: true,
        next: { taskId: 'task-a' },
      };
    },
  });
  const response = await route.handle({
    projectId: 'prj_default',
    input: { limit: 1 },
  });
  assert.deepEqual(calls, [{ projectId: 'prj_default', limit: 1 }]);
  assert.deepEqual(response, {
    statusCode: 200,
    body: {
      tasks: [
        {
          taskId: 'task-a',
          revision: 2,
          name: 'Task task-a',
          kind: 'command',
          specSchema: 'qinglong/command@v1',
          enabled: false,
          updatedAtMs: 20,
        },
      ],
      hasMore: true,
      next: { taskId: 'task-a' },
    },
  });
  assert.equal(JSON.stringify(response).includes('secret-adjacent'), false);
  assert.equal(JSON.stringify(response).includes('private'), false);
});

test('fails closed on cross-Project, malformed and unavailable pages', async () => {
  for (const page of [
    {
      definitions: [task('task-a', { projectId: 'prj_other' })],
      truncated: false,
    },
    {
      definitions: [task('task-a', { kind: 'invented' })],
      truncated: false,
    },
  ]) {
    const route = createLocalApiTaskListRoute({
      async listTaskDefinitions() { return page; },
    });
    assert.deepEqual(
      await route.handle({ projectId: 'prj_default', input: {} }),
      { statusCode: 503, body: { code: 'task_list_unavailable' } },
    );
  }
  const unavailable = createLocalApiTaskListRoute({
    async listTaskDefinitions() { throw new Error('offline'); },
  });
  assert.deepEqual(
    await unavailable.handle({ projectId: 'prj_default', input: {} }),
    { statusCode: 503, body: { code: 'task_list_unavailable' } },
  );
  assert.throws(() => createLocalApiTaskListRoute({}), TypeError);
});
