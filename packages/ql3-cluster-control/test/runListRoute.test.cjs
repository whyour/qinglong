const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_CONTROL_RUN_LIST_ROUTE,
  createClusterControlRunListRoute,
} = require('@qinglong/cluster-control/run-routes');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');

function run(id, createdAtMs, overrides = {}) {
  return {
    id,
    projectId: 'prj_default',
    taskId: `task-${id}`,
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 0,
    eventSequence: 1,
    priority: 0,
    createdAtMs,
    ...overrides,
  };
}

function authorized(query = {}, body = null) {
  return {
    projectId: 'prj_default',
    request: { query, body },
  };
}

test('publishes one reviewed bounded Run list route', () => {
  assert.deepEqual(CLUSTER_CONTROL_RUN_LIST_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/runs',
    operationId: 'run.list',
    permission: 'run.read',
    projectParameter: 'projectId',
    allowedQuery: ['after_created_at_ms', 'after_run_id', 'limit'],
  });
  assert.throws(() => createClusterControlRunListRoute({}), TypeError);
});

test('parses an exact keyset page and returns the shared projection', async () => {
  const calls = [];
  const route = createClusterControlRunListRoute({
    async listRunsByProject(query) {
      calls.push(query);
      return [run('run-a', 90)];
    },
  });
  const result = await route.handle(
    authorized({
      limit: ['8'],
      after_created_at_ms: ['100'],
      after_run_id: ['run-b'],
    }),
    {},
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.runs[0].id, 'run-a');
  assert.deepEqual(calls, [
    {
      projectId: 'prj_default',
      limit: 9,
      after: { createdAtMs: 100, runId: 'run-b' },
    },
  ]);
});

test('rejects malformed query and body and masks repository failures', async () => {
  const route = createClusterControlRunListRoute({
    async listRunsByProject() { throw new Error('offline'); },
  });
  for (const query of [
    { limit: ['08'] },
    { limit: ['65'] },
    { limit: ['8', '9'] },
    { after_run_id: ['run-a'] },
    { after_created_at_ms: ['-1'], after_run_id: ['run-a'] },
  ]) {
    assert.deepEqual(await route.handle(authorized(query), {}), {
      statusCode: 400,
      body: { code: 'invalid_run_list_query' },
    });
  }
  assert.deepEqual(await route.handle(authorized({}, { value: true }), {}), {
    statusCode: 400,
    body: { code: 'invalid_request_body' },
  });
  assert.deepEqual(await route.handle(authorized({}), {}), {
    statusCode: 503,
    body: { code: 'run_list_unavailable' },
  });
});

test('rejects non-canonical pagination before authentication', async () => {
  let authentications = 0;
  const pipeline = createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlRunListRoute({
        async listRunsByProject() { return []; },
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
      requestId: 'request-invalid-run-list',
      method: 'GET',
      path: '/api/v3/projects/prj_default/runs',
      query: { limit: ['08'] },
      headers: {},
      signal: new AbortController().signal,
    }),
    (error) => error.statusCode === 400 && error.code === 'invalid_route_query',
  );
  assert.equal(authentications, 0);
});
