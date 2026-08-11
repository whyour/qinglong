const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_CONTROL_RUN_EVENT_LIST_ROUTE,
  createClusterControlRunEventListRoute,
} = require('@qinglong/cluster-control/run-routes');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');

function run(projectId = 'prj_default') {
  return { id: 'run-1', projectId };
}

function event(sequence, overrides = {}) {
  return {
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type: `run.event.${sequence}`,
    actorType: 'system',
    actorId: 'private-actor',
    payload: { secret: 'must-not-cross-projection' },
    createdAtMs: 1_000 + sequence,
    ...overrides,
  };
}

function authorized(query = {}, body = null) {
  return {
    projectId: 'prj_default',
    request: { query, body },
  };
}

test('publishes one reviewed bounded Run event list route', () => {
  assert.deepEqual(CLUSTER_CONTROL_RUN_EVENT_LIST_ROUTE, {
    method: 'GET',
    path: '/api/v3/projects/{projectId}/runs/{runId}/events',
    operationId: 'run.events.list',
    permission: 'run.read',
    projectParameter: 'projectId',
    allowedQuery: ['after_sequence', 'limit'],
  });
  assert.throws(() => createClusterControlRunEventListRoute({}), TypeError);
});

test('returns the shared projection with exact sequence keyset input', async () => {
  const calls = [];
  const route = createClusterControlRunEventListRoute({
    async findRunById(runId) {
      calls.push(['run', runId]);
      return run();
    },
    async listEvents(runId, input) {
      calls.push(['events', runId, input]);
      return [event(3), event(4)];
    },
  });
  const result = await route.handle(
    authorized({ after_sequence: ['2'], limit: ['1'] }),
    { runId: 'run-1' },
  );
  assert.deepEqual(calls, [
    ['run', 'run-1'],
    ['events', 'run-1', { afterSequence: 2, limit: 2 }],
  ]);
  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      events: [
        {
          sequence: 3,
          type: 'run.event.3',
          actorType: 'system',
          createdAtMs: 1_003,
        },
      ],
      hasMore: true,
      nextAfterSequence: 3,
    },
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('masks Project mismatch and rejects malformed query before authentication', async () => {
  const route = createClusterControlRunEventListRoute({
    async findRunById() {
      return run('prj_other');
    },
    async listEvents() {
      throw new Error('must not read');
    },
  });
  assert.deepEqual(await route.handle(authorized(), { runId: 'run-1' }), {
    statusCode: 404,
    body: { code: 'run_not_found' },
  });

  let authentications = 0;
  const pipeline = createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([route]),
    authenticator: {
      authenticate() {
        authentications += 1;
        return null;
      },
    },
    policy: {
      authorize() {
        throw new Error('must not authorize');
      },
    },
    audit: {
      record() {
        throw new Error('must not audit');
      },
    },
    now: () => 10_000,
  });
  for (const query of [
    { after_sequence: ['02'] },
    { after_sequence: ['-1'] },
    { limit: ['65'] },
    { limit: ['1', '2'] },
  ]) {
    await assert.rejects(
      pipeline.prepare({
        requestId: 'request-invalid-run-event-list',
        method: 'GET',
        path: '/api/v3/projects/prj_default/runs/run-1/events',
        query,
        headers: {},
        signal: new AbortController().signal,
      }),
      (error) =>
        error.statusCode === 400 && error.code === 'invalid_route_query',
    );
  }
  assert.equal(authentications, 0);
});
