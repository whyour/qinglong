const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_CONTROL_TASK_READ_ROUTE,
  createClusterControlTaskReadRoute,
} = require('@qinglong/cluster-control/task-routes');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');

function task(overrides = {}) {
  return createTaskDefinitionRecord(
    {
      projectId: 'prj_default',
      taskId: 'task-a',
      expectedRevision: null,
      mutationId: '123e4567-e89b-42d3-a456-426614174201',
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

function authorized(body = null, query = {}) {
  return {
    projectId: 'prj_default',
    request: { body, query },
  };
}

test('publishes one reviewed current Task route', () => {
  assert.deepEqual(CLUSTER_CONTROL_TASK_READ_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/tasks/{taskId}',
    operationId: 'task.get',
    permission: 'task.read',
    projectParameter: 'projectId',
  });
  assert.throws(() => createClusterControlTaskReadRoute({}), TypeError);
});

test('returns the shared projection and masks absent or cross-Project Tasks', async () => {
  const definition = task({ enabled: false });
  const calls = [];
  const route = createClusterControlTaskReadRoute({
    async findCurrentTaskDefinition(projectId, taskId) {
      calls.push([projectId, taskId]);
      return taskId === 'task-a' ? definition : null;
    },
  });
  const result = await route.handle(authorized(), { taskId: 'task-a' });
  assert.deepEqual(calls, [['prj_default', 'task-a']]);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.task, {
    taskId: 'task-a',
    revision: 1,
    name: 'Task A',
    kind: 'command',
    specSchema: 'qinglong/command@v1',
    enabled: false,
    contentDigest: definition.contentDigest,
    createdAtMs: 10,
    updatedAtMs: 20,
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(
    await route.handle(authorized(), { taskId: 'task-absent' }),
    { statusCode: 404, body: { code: 'task_not_found' } },
  );
  const crossProject = createClusterControlTaskReadRoute({
    async findCurrentTaskDefinition() { return task({ projectId: 'other' }); },
  });
  assert.deepEqual(
    await crossProject.handle(authorized(), { taskId: 'task-a' }),
    { statusCode: 404, body: { code: 'task_not_found' } },
  );
});

test('rejects body and fails closed on corrupt or unavailable storage', async () => {
  const definition = task();
  const corrupt = createClusterControlTaskReadRoute({
    async findCurrentTaskDefinition() {
      return { ...definition, contentDigest: '0'.repeat(64) };
    },
  });
  assert.deepEqual(
    await corrupt.handle(authorized(), { taskId: 'task-a' }),
    { statusCode: 503, body: { code: 'task_query_unavailable' } },
  );
  assert.deepEqual(
    await corrupt.handle(authorized({ invalid: true }), { taskId: 'task-a' }),
    { statusCode: 400, body: { code: 'invalid_request_body' } },
  );
  const unavailable = createClusterControlTaskReadRoute({
    async findCurrentTaskDefinition() { throw new Error('offline'); },
  });
  assert.deepEqual(
    await unavailable.handle(authorized(), { taskId: 'task-a' }),
    { statusCode: 503, body: { code: 'task_query_unavailable' } },
  );
});

test('rejects query before authentication', async () => {
  let authentications = 0;
  const pipeline = createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlTaskReadRoute({
        async findCurrentTaskDefinition() { return null; },
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
      requestId: 'request-invalid-task-get',
      method: 'GET',
      path: '/api/v3/projects/prj_default/tasks/task-a',
      query: { expanded: ['true'] },
      headers: {},
      signal: new AbortController().signal,
    }),
    (error) => error.statusCode === 400 && error.code === 'invalid_route_query',
  );
  assert.equal(authentications, 0);
});
