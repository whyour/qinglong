'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  TASK_START_SCHEMA,
  createTaskStartResponseBody,
  normalizeTaskStartCommand,
  normalizeTaskStartResult,
  parseTaskStartRequestBody,
  parseTaskStartResponseBody,
} = require('@qinglong/runtime-core/task-start');

const DIGEST = 'a'.repeat(64);
const EXECUTION_DIGEST = 'b'.repeat(64);

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    mutationId: '019f7300-0000-7000-8000-000000000001',
    expectedRevision: 3,
    expectedContentDigest: DIGEST,
    runId: '019f7300-0000-7000-8000-000000000002',
    attemptId: '019f7300-0000-7000-8000-000000000003',
    createdEventId: '019f7300-0000-7000-8000-000000000004',
    queuedEventId: '019f7300-0000-7000-8000-000000000005',
    subject: { type: 'user', id: 'user-1' },
    policyFence: { projectVersion: 2, bindingVersion: 4 },
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    status: 'accepted',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 3,
    taskContentDigest: DIGEST,
    runId: '019f7300-0000-7000-8000-000000000002',
    attemptId: '019f7300-0000-7000-8000-000000000003',
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'local_process',
    executionRevisionDigest: EXECUTION_DIGEST,
    createdAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

test('accepts only the exact digest-fenced Task start wire body', () => {
  const body = {
    schema: TASK_START_SCHEMA,
    mutationId: command().mutationId,
    expectedRevision: 3,
    expectedContentDigest: DIGEST,
  };
  assert.equal(TASK_START_SCHEMA, 'qinglong/task-start@v1');
  assert.deepEqual(parseTaskStartRequestBody(body), body);
  assert.throws(
    () => parseTaskStartRequestBody({ ...body, command: '/bin/sh' }),
    /shape is invalid/,
  );
  assert.throws(
    () => parseTaskStartRequestBody({ ...body, mutationId: 'MUTATION' }),
    /mutationId is invalid/,
  );
  assert.throws(
    () => parseTaskStartRequestBody({ ...body, expectedContentDigest: 'A'.repeat(64) }),
    /expectedContentDigest is invalid/,
  );
});

test('normalizes complete server-owned identities and authorization fence', () => {
  assert.deepEqual(normalizeTaskStartCommand(command()), command());
  assert.throws(
    () => normalizeTaskStartCommand(command({ policyFence: {
      projectVersion: 2,
      bindingVersion: null,
    } })),
    /authorization fence is incomplete/,
  );
  assert.throws(
    () => normalizeTaskStartCommand(command({ runId: 'caller-run-id' })),
    /runId is invalid/,
  );
});

test('round-trips accepted and existing bounded receipts', () => {
  assert.deepEqual(normalizeTaskStartResult(result()), result());
  const existing = result({
    status: 'existing',
    executorType: 'remote_worker',
  });
  const body = createTaskStartResponseBody(existing);
  assert.equal(body.schema, TASK_START_SCHEMA);
  assert.deepEqual(parseTaskStartResponseBody(body), body);
  assert.throws(
    () => normalizeTaskStartResult(result({ runVersion: 3 })),
    /result state is invalid/,
  );
  assert.throws(
    () => parseTaskStartResponseBody({ ...body, command: {} }),
    /shape is invalid/,
  );
});
