'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  TASK_START_SCHEMA,
  TaskStartFenceRejectedError,
  TaskStartNotFoundError,
  TaskStartUnavailableError,
} = require('@qinglong/runtime-core/task-start');
const {
  createClusterControlAdmissionPipeline,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  CLUSTER_CONTROL_TASK_START_ROUTE,
  createClusterControlTaskStartRoute,
} = require('@qinglong/cluster-control/task-routes');

const IDS = [
  '019f7300-0000-7000-8000-000000000601',
  '019f7300-0000-7000-8000-000000000602',
  '019f7300-0000-7000-8000-000000000603',
  '019f7300-0000-7000-8000-000000000604',
];
const MUTATION_ID = '019f7300-0000-7000-8000-000000000600';
const DIGEST = 'a'.repeat(64);
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'user-1' }),
  authenticationId: 'session:user-1',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'single_factor',
});
const METADATA = Object.freeze({
  requestId: 'request-task-start',
  method: 'POST',
  path: '/api/v3/projects/project-1/tasks/task-1/runs',
  query: Object.freeze({}),
  headers: Object.freeze({ authorization: 'Bearer opaque' }),
  signal: new AbortController().signal,
});

function receipt(overrides = {}) {
  return {
    status: 'accepted',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 3,
    taskContentDigest: DIGEST,
    runId: IDS[0],
    attemptId: IDS[1],
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'remote_worker',
    executionRevisionDigest: 'b'.repeat(64),
    createdAtMs: 10_000,
    ...overrides,
  };
}

function pipeline(repository, events = [], fence = {
  projectVersion: 2,
  bindingVersion: 3,
}) {
  let index = 0;
  return createClusterControlAdmissionPipeline({
    routes: createClusterControlRouteRegistry([
      createClusterControlTaskStartRoute(repository, () => IDS[index++]),
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
        return { effect: 'allow', reasons: ['role_grant'], fence };
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

function body(overrides = {}) {
  return {
    schema: TASK_START_SCHEMA,
    mutationId: MUTATION_ID,
    expectedRevision: 3,
    expectedContentDigest: DIGEST,
    ...overrides,
  };
}

test('publishes one reviewed run.start Task route', () => {
  assert.deepEqual(CLUSTER_CONTROL_TASK_START_ROUTE, {
    method: 'POST',
    path: '/api/v3/projects/{projectId}/tasks/{taskId}/runs',
    operationId: 'task.start',
    permission: 'run.start',
    projectParameter: 'projectId',
  });
});

test('authenticates, authorizes and audits before starting the exact Task', async () => {
  const events = [];
  let observed;
  const prepared = await pipeline({
    async startTask(command) {
      events.push('repository');
      observed = command;
      return receipt();
    },
  }, events).prepare(METADATA);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.start:project-1',
    'audit:allowed:task.start',
  ]);
  assert.deepEqual(await prepared.handle(body()), {
    statusCode: 202,
    body: { schema: TASK_START_SCHEMA, ...receipt() },
  });
  assert.deepEqual(observed, {
    projectId: 'project-1',
    taskId: 'task-1',
    mutationId: MUTATION_ID,
    expectedRevision: 3,
    expectedContentDigest: DIGEST,
    runId: IDS[0],
    attemptId: IDS[1],
    createdEventId: IDS[2],
    queuedEventId: IDS[3],
    subject: PRINCIPAL.subject,
    policyFence: { projectVersion: 2, bindingVersion: 3 },
  });
});

test('rejects command injection and maps replay plus stable failures', async () => {
  let calls = 0;
  const invalid = await pipeline({
    async startTask() { calls += 1; return receipt(); },
  }).prepare(METADATA);
  assert.equal((await invalid.handle(body({ command: '/bin/sh' }))).statusCode, 400);
  assert.equal(calls, 0);

  const replay = await pipeline({
    async startTask() { return receipt({ status: 'existing' }); },
  }).prepare(METADATA);
  assert.equal((await replay.handle(body())).statusCode, 200);

  for (const [error, statusCode, code] of [
    [new TaskStartNotFoundError(), 404, 'task_not_found'],
    [new TaskStartFenceRejectedError('definition_changed'), 409, 'task_start_fence_rejected'],
    [new TaskStartUnavailableError(), 503, 'task_start_unavailable'],
  ]) {
    const prepared = await pipeline({
      async startTask() { throw error; },
    }).prepare(METADATA);
    const result = await prepared.handle(body());
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.body.code, code);
  }
});
