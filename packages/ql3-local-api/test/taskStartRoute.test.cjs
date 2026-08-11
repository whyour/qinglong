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
  createLocalApiTaskStartRoute,
} = require('../dist/task/taskStartRoute.js');

const IDS = [
  '019f7300-0000-7000-8000-000000000701',
  '019f7300-0000-7000-8000-000000000702',
  '019f7300-0000-7000-8000-000000000703',
  '019f7300-0000-7000-8000-000000000704',
];
const MUTATION_ID = '019f7300-0000-7000-8000-000000000700';
const DIGEST = 'a'.repeat(64);
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'user-1' }),
  authenticationId: 'credential-1',
  authenticatedAtMs: 1,
  expiresAtMs: 20,
  assurance: 'single_factor',
});

function request(overrides = {}) {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    body: {
      schema: TASK_START_SCHEMA,
      mutationId: MUTATION_ID,
      expectedRevision: 3,
      expectedContentDigest: DIGEST,
    },
    principal: PRINCIPAL,
    policyFence: { projectVersion: 2, bindingVersion: 4 },
    ...overrides,
  };
}

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
    executorType: 'local_process',
    executionRevisionDigest: 'b'.repeat(64),
    createdAtMs: 10,
    ...overrides,
  };
}

function route(repository) {
  let index = 0;
  return createLocalApiTaskStartRoute(repository, () => IDS[index++]);
}

test('publishes one server-owned Task start command and exact receipt', async () => {
  let observed;
  const result = await route({
    async startTask(command) {
      observed = command;
      return receipt();
    },
  }).handle(request());
  assert.deepEqual(result, {
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
    policyFence: { projectVersion: 2, bindingVersion: 4 },
  });
});

test('rejects widened bodies and maps replay plus stable failures', async () => {
  let calls = 0;
  assert.equal((await route({
    async startTask() { calls += 1; return receipt(); },
  }).handle(request({ body: { ...request().body, command: '/bin/sh' } }))).statusCode, 400);
  assert.equal(calls, 0);

  assert.equal((await route({
    async startTask() { return receipt({ status: 'existing' }); },
  }).handle(request())).statusCode, 200);

  for (const [error, statusCode, code] of [
    [new TaskStartNotFoundError(), 404, 'task_not_found'],
    [new TaskStartFenceRejectedError('task_disabled'), 409, 'task_start_fence_rejected'],
    [new TaskStartUnavailableError(), 503, 'task_start_unavailable'],
  ]) {
    const result = await route({ async startTask() { throw error; } }).handle(request());
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.body.code, code);
  }
});
