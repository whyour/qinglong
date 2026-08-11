'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CLUSTER_RUN_CANCELLATION_SCHEMA,
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
  ClusterRunCancellationUnavailableError,
} = require('@qinglong/runtime-core/cluster-run-cancellation');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  CLUSTER_CONTROL_RUN_CANCELLATION_ROUTE,
  createClusterControlRunCancellationRoute,
} = require('@qinglong/cluster-control/run-routes');

const EVENT_ID = '018f0000-0000-7000-8000-000000000001';
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'user-1' }),
  authenticationId: 'session:user-1',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'single_factor',
});
const METADATA = Object.freeze({
  requestId: 'request-cancel-run',
  method: 'POST',
  path: '/api/v3/projects/project-1/runs/run-1/cancellation',
  query: Object.freeze({}),
  headers: Object.freeze({ authorization: 'Bearer opaque' }),
  signal: new AbortController().signal,
});

function accepted(overrides = {}) {
  return {
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 10_000,
    cancelReason: 'user',
    ...overrides,
  };
}

function pipeline(repository, events = [], policyFence = {
  projectVersion: 2,
  bindingVersion: 3,
}) {
  return createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlRunCancellationRoute(repository, () => EVENT_ID),
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
        return { effect: 'allow', reasons: ['role_grant'], fence: policyFence };
      },
    },
    audit: {
      record(record) {
        events.push(`audit:${record.outcome}:${record.operationId}`);
      },
    },
    now: () => 10_000,
  });
}

test('publishes one reviewed run.stop mutation route', () => {
  const route = createClusterControlRunCancellationRoute({
    async requestUserCancellation() { return accepted(); },
  }, () => EVENT_ID);
  assert.deepEqual(CLUSTER_CONTROL_RUN_CANCELLATION_ROUTE, {
    method: 'POST',
    path: '/api/v3/projects/{projectId}/runs/{runId}/cancellation',
    operationId: 'run.cancel',
    permission: 'run.stop',
    projectParameter: 'projectId',
  });
  assert.equal(Object.isFrozen(route), true);
});

test('authenticates, authorizes and audits before committing cancellation', async () => {
  const events = [];
  let observed;
  const prepared = await pipeline({
    async requestUserCancellation(command) {
      events.push('repository');
      observed = command;
      return accepted();
    },
  }, events).prepare(METADATA);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.stop:project-1',
    'audit:allowed:run.cancel',
  ]);
  assert.deepEqual(await prepared.handle({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: 'mutation-1',
  }), {
    statusCode: 202,
    body: {
      schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
      ...accepted(),
    },
  });
  assert.deepEqual(observed, {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: 'mutation-1',
    eventId: EVENT_ID,
    subject: PRINCIPAL.subject,
    policyFence: { projectVersion: 2, bindingVersion: 3 },
  });
  assert.equal(events.at(-1), 'repository');
});

test('rejects caller-selected reasons and missing policy fences', async () => {
  let calls = 0;
  const repository = {
    async requestUserCancellation() { calls += 1; return accepted(); },
  };
  const prepared = await pipeline(repository).prepare(METADATA);
  assert.deepEqual(await prepared.handle({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: 'mutation-1',
    reason: 'shutdown',
  }), {
    statusCode: 400,
    body: {
      code: 'invalid_run_cancellation_request',
      schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    },
  });
  const unfenced = await pipeline(repository, [], null).prepare(METADATA);
  assert.deepEqual(await unfenced.handle({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: 'mutation-1',
  }), {
    statusCode: 503,
    body: { code: 'run_cancellation_unavailable' },
  });
  assert.equal(calls, 0);
});

test('maps replay, terminal, missing, fenced and unavailable outcomes', async () => {
  for (const [outcome, expected] of [
    [accepted({ status: 'already_requested' }), 200],
    [{
      status: 'already_terminal',
      projectId: 'project-1',
      runId: 'run-1',
      runStatus: 'succeeded',
      runVersion: 6,
      eventSequence: 8,
    }, 200],
  ]) {
    const prepared = await pipeline({
      async requestUserCancellation() { return outcome; },
    }).prepare(METADATA);
    const result = await prepared.handle({
      schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
      mutationId: 'mutation-1',
    });
    assert.equal(result.statusCode, expected);
  }

  const errors = [
    [new ClusterRunCancellationNotFoundError(), 404, 'run_not_found'],
    [
      new ClusterRunCancellationFenceRejectedError('authorization_changed'),
      409,
      'run_cancellation_fence_rejected',
    ],
    [
      new ClusterRunCancellationUnavailableError(),
      503,
      'run_cancellation_unavailable',
    ],
  ];
  for (const [error, statusCode, code] of errors) {
    const prepared = await pipeline({
      async requestUserCancellation() { throw error; },
    }).prepare(METADATA);
    const result = await prepared.handle({
      schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
      mutationId: 'mutation-1',
    });
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.body.code, code);
  }
});
