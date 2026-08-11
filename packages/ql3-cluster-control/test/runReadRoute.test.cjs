const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  CLUSTER_CONTROL_RUN_READ_ROUTE,
  createClusterControlRunReadRoute,
} = require('@qinglong/cluster-control/run-routes');
const {
  startClusterControlHttpSurface,
} = require('@qinglong/cluster-control/http');

const NOW = 10_000;
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'usr_viewer' }),
  authenticationId: 'session:viewer',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'single_factor',
});
const METADATA = Object.freeze({
  requestId: 'request-run-read',
  method: 'GET',
  path: '/api/v3/projects/prj_default/runs/run_123',
  query: Object.freeze({}),
  headers: Object.freeze({ authorization: 'Bearer opaque' }),
  signal: new AbortController().signal,
});
const EVIDENCE = Object.freeze({
  contractName: 'control-core',
  contractVersion: 5,
  serverMajor: 16,
  migrationIds: Object.freeze(['pg-0001', 'pg-0002']),
});

function httpRequest(address, path) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: address.host,
        port: address.port,
        path,
        headers: {
          authorization: 'Bearer opaque',
          connection: 'close',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function run(overrides = {}) {
  return {
    id: 'run_123',
    projectId: 'prj_default',
    taskId: 'task_1',
    taskRevision: 'revision_7',
    taskName: 'must not cross the wire',
    taskSnapshotRef: 'secret-adjacent-ref',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: 'private-user-id',
    requestId: 'private-request-id',
    status: 'running',
    version: 4,
    eventSequence: 6,
    priority: 10,
    inputRef: 'private-input-ref',
    outputRef: 'private-output-ref',
    createdAtMs: 1_000,
    queuedAtMs: 2_000,
    startedAtMs: 3_000,
    errorCode: 'private-error-code',
    errorSummary: 'private error detail',
    ...overrides,
  };
}

function admission(repository, events = [], overrides = {}) {
  return createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlRunReadRoute(repository),
    ]),
    authenticator: {
      authenticate() {
        events.push('authenticate');
        return PRINCIPAL;
      },
    },
    policy: {
      authorize(request) {
        events.push(`authorize:${request.permission}:${request.projectId}`);
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 2, bindingVersion: 3 },
        };
      },
    },
    audit: {
      record(record) {
        events.push(`audit:${record.outcome}:${record.operationId}`);
      },
    },
    now: () => NOW,
    ...overrides,
  });
}

test('publishes one immutable reviewed Run read route', () => {
  const route = createClusterControlRunReadRoute({
    async findRunById() {
      return null;
    },
  });
  assert.deepEqual(CLUSTER_CONTROL_RUN_READ_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/runs/{runId}',
    operationId: 'run.get',
    permission: 'run.read',
    projectParameter: 'projectId',
  });
  assert.equal(Object.isFrozen(route), true);
  assert.throws(() => createClusterControlRunReadRoute({}), TypeError);
});

test('authenticates, authorizes and audits before one bounded Run lookup', async () => {
  const events = [];
  const pipeline = admission(
    {
      async findRunById(runId) {
        events.push(`repository:${runId}`);
        return run({ version: 0 });
      },
    },
    events,
  );

  const prepared = await pipeline.prepare(METADATA);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.read:prj_default',
    'audit:allowed:run.get',
  ]);
  assert.deepEqual(await prepared.handle(null), {
    statusCode: 200,
    body: {
      run: {
        id: 'run_123',
        projectId: 'prj_default',
        taskId: 'task_1',
        taskRevision: 'revision_7',
        status: 'running',
        version: 0,
        eventSequence: 6,
        priority: 10,
        executionOrigin: 'manual',
        executionOwner: 'runtime',
        createdAtMs: 1_000,
        queuedAtMs: 2_000,
        startedAtMs: 3_000,
        finishedAtMs: null,
      },
    },
  });
  assert.deepEqual(events.slice(-1), ['repository:run_123']);
  assert.equal(
    JSON.stringify(await prepared.handle(null)).includes('private'),
    false,
  );
});

test('serves the reviewed Run projection through the bounded HTTP surface', async (t) => {
  const events = [];
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => surface.close());
  const dispose = surface.installAdmission(
    EVIDENCE,
    admission(
      {
        async findRunById(runId) {
          events.push(`repository:${runId}`);
          return run({ status: 'succeeded', finishedAtMs: 4_000 });
        },
      },
      events,
    ),
  );
  t.after(() => dispose());

  const result = await httpRequest(
    surface.address,
    '/api/v3/projects/prj_default/runs/run_123',
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.run.id, 'run_123');
  assert.equal(result.body.run.projectId, 'prj_default');
  assert.equal(result.body.run.status, 'succeeded');
  assert.equal(result.body.run.finishedAtMs, 4_000);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.read:prj_default',
    'audit:allowed:run.get',
    'repository:run_123',
  ]);
});

test('does not query storage when authentication fails', async () => {
  let queries = 0;
  const pipeline = admission(
    {
      async findRunById() {
        queries += 1;
        return run();
      },
    },
    [],
    { authenticator: { authenticate: () => null } },
  );
  await assert.rejects(
    pipeline.prepare(METADATA),
    (error) =>
      error.statusCode === 401 && error.code === 'authentication_required',
  );
  assert.equal(queries, 0);
});

test('masks absent, cross-Project, corrupt and unavailable Run records', async () => {
  for (const [record, expected] of [
    [null, { statusCode: 404, body: { code: 'run_not_found' } }],
    [
      run({ projectId: 'prj_other' }),
      { statusCode: 404, body: { code: 'run_not_found' } },
    ],
    [
      run({ taskRevision: '\ncorrupt' }),
      { statusCode: 503, body: { code: 'run_query_unavailable' } },
    ],
    [
      { id: 'run_123' },
      { statusCode: 503, body: { code: 'run_query_unavailable' } },
    ],
  ]) {
    const prepared = await admission({
      async findRunById() {
        return record;
      },
    }).prepare(METADATA);
    assert.deepEqual(await prepared.handle(null), expected);
  }

  const unavailable = await admission({
    async findRunById() {
      throw new Error('postgresql secret detail');
    },
  }).prepare(METADATA);
  const response = await unavailable.handle(null);
  assert.deepEqual(response, {
    statusCode: 503,
    body: { code: 'run_query_unavailable' },
  });
  assert.equal(JSON.stringify(response).includes('postgresql'), false);
});

test('rejects a GET body without touching the Run repository', async () => {
  let queries = 0;
  const prepared = await admission({
    async findRunById() {
      queries += 1;
      return run();
    },
  }).prepare(METADATA);
  assert.deepEqual(await prepared.handle({ unexpected: true }), {
    statusCode: 400,
    body: { code: 'invalid_request_body' },
  });
  assert.equal(queries, 0);
});
