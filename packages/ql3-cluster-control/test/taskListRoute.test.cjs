const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_CONTROL_TASK_LIST_ROUTE,
  createClusterControlTaskListRoute,
} = require('@qinglong/cluster-control/task-routes');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');

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

function authorized(query = {}, body = null) {
  return {
    projectId: 'prj_default',
    request: { query, body },
  };
}

test('publishes one reviewed bounded Task list route', () => {
  assert.deepEqual(CLUSTER_CONTROL_TASK_LIST_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/tasks',
    operationId: 'task.list',
    permission: 'task.read',
    projectParameter: 'projectId',
    allowedQuery: ['after_task_id', 'limit'],
  });
  assert.throws(() => createClusterControlTaskListRoute({}), TypeError);
});

test('parses an exact keyset page and returns the shared projection', async () => {
  const calls = [];
  const route = createClusterControlTaskListRoute({
    async listTaskDefinitions(query) {
      calls.push(query);
      return {
        definitions: [task('task-b', { enabled: false })],
        truncated: true,
        next: { taskId: 'task-b' },
      };
    },
  });
  const result = await route.handle(
    authorized({ limit: ['8'], after_task_id: ['task-a'] }),
    {},
  );
  assert.deepEqual(calls, [
    {
      projectId: 'prj_default',
      limit: 8,
      after: { taskId: 'task-a' },
    },
  ]);
  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      tasks: [
        {
          taskId: 'task-b',
          revision: 2,
          name: 'Task task-b',
          kind: 'command',
          specSchema: 'qinglong/command@v1',
          enabled: false,
          updatedAtMs: 20,
        },
      ],
      hasMore: true,
      next: { taskId: 'task-b' },
    },
  });
  assert.equal(JSON.stringify(result).includes('secret-adjacent'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('rejects malformed query and body and masks repository failures', async () => {
  const route = createClusterControlTaskListRoute({
    async listTaskDefinitions() { throw new Error('offline'); },
  });
  for (const query of [
    { limit: ['08'] },
    { limit: ['65'] },
    { limit: ['8', '9'] },
    { after_task_id: ['-bad'] },
  ]) {
    assert.deepEqual(await route.handle(authorized(query), {}), {
      statusCode: 400,
      body: { code: 'invalid_task_list_query' },
    });
  }
  assert.deepEqual(await route.handle(authorized({}, { value: true }), {}), {
    statusCode: 400,
    body: { code: 'invalid_request_body' },
  });
  assert.deepEqual(await route.handle(authorized({}), {}), {
    statusCode: 503,
    body: { code: 'task_list_unavailable' },
  });
});

test('rejects non-canonical pagination before authentication', async () => {
  let authentications = 0;
  const pipeline = createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlTaskListRoute({
        async listTaskDefinitions() {
          return { definitions: [], truncated: false };
        },
      }),
    ]),
    authenticator: {
      authenticate() {
        authentications += 1;
        return null;
      },
    },
    policy: { authorize() { throw new Error('must not authorize'); } },
    audit: { record() { throw new Error('must not audit'); } },
    now: () => 10_000,
  });
  await assert.rejects(
    pipeline.prepare({
      requestId: 'request-invalid-task-list',
      method: 'GET',
      path: '/api/v3/projects/prj_default/tasks',
      query: { limit: ['08'] },
      headers: {},
      signal: new AbortController().signal,
    }),
    (error) => error.statusCode === 400 && error.code === 'invalid_route_query',
  );
  assert.equal(authentications, 0);
});
