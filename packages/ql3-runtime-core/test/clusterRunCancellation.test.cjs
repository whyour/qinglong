'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CLUSTER_RUN_CANCELLATION_SCHEMA,
  createClusterRunCancellationResponseBody,
  normalizeClusterRunCancellationCommand,
  normalizeClusterRunCancellationResult,
  parseClusterRunCancellationRequestBody,
  parseClusterRunCancellationResponseBody,
} = require('../dist/run/clusterRunCancellation');
const {
  RUN_CANCELLATION_SCHEMA,
  parseRunCancellationRequestBody,
} = require('@qinglong/runtime-core/run-cancellation');

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: 'mutation-1',
    eventId: '018f0000-0000-7000-8000-000000000001',
    subject: { type: 'user', id: 'user-1' },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

test('accepts one exact cancellation wire body and complete authority', () => {
  assert.equal(RUN_CANCELLATION_SCHEMA, 'qinglong/run-cancellation@v1');
  assert.equal(CLUSTER_RUN_CANCELLATION_SCHEMA, RUN_CANCELLATION_SCHEMA);
  assert.deepEqual(parseClusterRunCancellationRequestBody({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: 'mutation-1',
  }), {
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: 'mutation-1',
  });
  assert.deepEqual(
    parseRunCancellationRequestBody({
      schema: RUN_CANCELLATION_SCHEMA,
      mutationId: 'mutation-1',
    }),
    {
      schema: RUN_CANCELLATION_SCHEMA,
      mutationId: 'mutation-1',
    },
  );
  assert.deepEqual(normalizeClusterRunCancellationCommand(command()), command());
});

test('normalizes an exact optional Plugin Package Workflow target', () => {
  const targeted = command({
    workflowTarget: { packageName: 'example-package', workflowId: 'daily' },
  });
  assert.deepEqual(normalizeClusterRunCancellationCommand(targeted), targeted);
  assert.throws(
    () =>
      normalizeClusterRunCancellationCommand(
        command({
          workflowTarget: {
            packageName: 'Example',
            workflowId: 'daily',
          },
        }),
      ),
    /workflowTarget is invalid/,
  );
  assert.throws(
    () =>
      normalizeClusterRunCancellationCommand(
        command({
          workflowTarget: {
            packageName: 'example',
            workflowId: 'daily',
            generation: 1,
          },
        }),
      ),
    /shape is invalid/,
  );
});

test('rejects unknown body fields and incomplete policy fences', () => {
  assert.throws(() => parseClusterRunCancellationRequestBody({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: 'mutation-1',
    reason: 'shutdown',
  }), /shape is invalid/);
  assert.throws(() => normalizeClusterRunCancellationCommand(command({
    policyFence: { projectVersion: 2, bindingVersion: null },
  })), /authorization fence is incomplete/);
});

test('normalizes accepted, replayed and terminal projections', () => {
  assert.deepEqual(normalizeClusterRunCancellationResult({
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 1_800_000_000_000,
    cancelReason: 'user',
  }), {
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 1_800_000_000_000,
    cancelReason: 'user',
  });
  assert.equal(normalizeClusterRunCancellationResult({
    status: 'already_requested',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'dispatching',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 900,
    cancelReason: 'timeout',
  }).cancelReason, 'timeout');
  assert.deepEqual(normalizeClusterRunCancellationResult({
    status: 'already_terminal',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'succeeded',
    runVersion: 6,
    eventSequence: 8,
  }), {
    status: 'already_terminal',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'succeeded',
    runVersion: 6,
    eventSequence: 8,
  });
});

test('keeps lost Runs cancellable because retry authority is still open', () => {
  assert.deepEqual(normalizeClusterRunCancellationResult({
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'lost',
    runVersion: 3,
    eventSequence: 2,
    cancelRequestedAtMs: 1_750_000_000_000,
    cancelReason: 'user',
  }), {
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'lost',
    runVersion: 3,
    eventSequence: 2,
    cancelRequestedAtMs: 1_750_000_000_000,
    cancelReason: 'user',
  });
});

test('round-trips one exact versioned cancellation response', () => {
  const body = createClusterRunCancellationResponseBody({
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 1_000,
    cancelReason: 'user',
  });
  assert.equal(body.schema, CLUSTER_RUN_CANCELLATION_SCHEMA);
  assert.deepEqual(parseClusterRunCancellationResponseBody(body), body);
  assert.throws(() => parseClusterRunCancellationResponseBody({
    ...body,
    extra: true,
  }), /shape is invalid/);
});

test('rejects contradictory cancellation projections', () => {
  assert.throws(() => normalizeClusterRunCancellationResult({
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
  }), /result state is invalid/);
  assert.throws(() => normalizeClusterRunCancellationResult({
    status: 'already_terminal',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
  }), /result state is invalid/);
});
