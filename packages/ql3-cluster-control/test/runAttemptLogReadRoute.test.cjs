const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  CLUSTER_CONTROL_RUN_ATTEMPT_LOG_READ_ROUTE,
  createClusterControlRunAttemptLogReadRoute,
} = require('../dist/run/runAttemptLogReadRoute.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'usr_viewer' }),
  authenticationId: 'session:viewer',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'single_factor',
});

function run(overrides = {}) {
  return {
    id: 'run_123',
    projectId: 'prj_default',
    taskId: 'task_1',
    taskRevision: 'revision_1',
    triggerType: 'task_start',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 2,
    eventSequence: 2,
    priority: 0,
    createdAtMs: 1,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: 'attempt_123',
    runId: 'run_123',
    attempt: 1,
    status: 'running',
    executorType: 'remote_worker',
    logArtifactId: `wlog-${'a'.repeat(30)}`,
    callbackSequence: 0,
    createdAtMs: 1,
    ...overrides,
  };
}

function metadata(query = {}) {
  return Object.freeze({
    requestId: 'request-log-read',
    method: 'GET',
    path: '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_123/log',
    query: Object.freeze(query),
    headers: Object.freeze({ authorization: 'Bearer opaque' }),
    signal: new AbortController().signal,
  });
}

function pipeline(options = {}) {
  const events = options.events ?? [];
  const repository = options.repository ?? {
    async findRunById() {
      events.push('run');
      return run();
    },
    async findAttemptById() {
      events.push('attempt');
      return attempt();
    },
  };
  const reader = options.reader ?? {
    async read(identity, range) {
      events.push(`storage:${range.offset}:${range.length}`);
      return {
        status: 'available',
        content: Buffer.from('cluster-log'),
        start: range.offset,
        endExclusive: range.offset + 11,
        totalBytes: range.offset + 20,
        nextOffset: range.offset + 11,
        truncation: { truncated: false },
      };
    },
  };
  return createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlRunAttemptLogReadRoute(repository, reader),
    ]),
    authenticator: {
      authenticate() {
        events.push('authenticate');
        return PRINCIPAL;
      },
    },
    policy: {
      authorize(request) {
        events.push(`authorize:${request.permission}`);
        return options.effect
          ? { effect: options.effect, reasons: ['masked'], fence: null }
          : {
              effect: 'allow',
              reasons: ['role_grant'],
              fence: { projectVersion: 2, bindingVersion: 3 },
            };
      },
    },
    audit: {
      record(record) {
        events.push(`audit:${record.outcome}`);
      },
    },
    now: () => 10_000,
  });
}

async function invoke(value, query = {}) {
  const prepared = await value.prepare(metadata(query));
  return prepared.handle(null);
}

test('publishes the immutable Artifact-scoped route contract', () => {
  assert.deepEqual(CLUSTER_CONTROL_RUN_ATTEMPT_LOG_READ_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/runs/{runId}/attempts/{attemptId}/log',
    operationId: 'run.log.read',
    permission: 'artifact.read',
    projectParameter: 'projectId',
    allowedQuery: ['length', 'offset'],
  });
});

test('authorizes and audits before metadata and one bounded range read', async () => {
  const events = [];
  const result = await invoke(pipeline({ events }), {
    offset: ['4'],
    length: ['16'],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.schema, 'qinglong/run-attempt-log-read-result@v1');
  assert.equal(
    Buffer.from(result.body.content, 'base64').toString(),
    'cluster-log',
  );
  assert.deepEqual(result.body.range, {
    start: 4,
    endExclusive: 15,
    totalBytes: 24,
    nextOffset: 15,
  });
  assert.deepEqual(events, [
    'authenticate',
    'authorize:artifact.read',
    'audit:allowed',
    'run',
    'attempt',
    'storage:4:16',
  ]);
});

test('uses the Cluster default window and rejects unbounded query values', async () => {
  const events = [];
  assert.equal((await invoke(pipeline({ events }))).statusCode, 200);
  assert.equal(events.at(-1), `storage:0:${64 * 1024}`);
  for (const query of [
    { offset: ['-1'] },
    { offset: ['04'] },
    { length: ['0'] },
    { length: [String(256 * 1024 + 1)] },
    { length: ['1', '2'] },
  ]) {
    await assert.rejects(
      pipeline().prepare(metadata(query)),
      (error) =>
        error.statusCode === 400 && error.code === 'invalid_route_query',
    );
  }
});

test('masks deny and approval without reading Run or object storage', async () => {
  for (const effect of ['deny', 'require_approval']) {
    let touched = false;
    await assert.rejects(
      pipeline({
        effect,
        repository: {
          async findRunById() {
            touched = true;
            return run();
          },
          async findAttemptById() {
            touched = true;
            return attempt();
          },
        },
        reader: {
          async read() {
            touched = true;
            return { status: 'missing' };
          },
        },
      }).prepare(metadata()),
      (error) =>
        error.statusCode === 404 && error.code === 'artifact_not_found',
    );
    assert.equal(touched, false);
  }
});

test('returns pending during upload and fails closed without an object reader', async () => {
  const pending = pipeline({
    reader: {
      async read() {
        return { status: 'missing' };
      },
    },
  });
  assert.equal((await invoke(pending)).statusCode, 202);

  const unavailableRoute = createClusterControlRunAttemptLogReadRoute({
    async findRunById() {
      return run();
    },
    async findAttemptById() {
      return attempt();
    },
  });
  const prepared = await createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([unavailableRoute]),
    authenticator: { authenticate: () => PRINCIPAL },
    policy: {
      authorize: () => ({
        effect: 'allow',
        reasons: ['role_grant'],
        fence: { projectVersion: 1, bindingVersion: 1 },
      }),
    },
    audit: { record() {} },
    now: () => 10_000,
  }).prepare(metadata());
  assert.deepEqual(await prepared.handle(null), {
    statusCode: 503,
    body: { code: 'artifact_unavailable' },
  });
});
