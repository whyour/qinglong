'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRunCancellationInspectionCommand,
  projectRunCancellationInspection,
} = require('../dist/run-management/runCancellationInspection.js');

const uuids = [
  'console-request-1',
  '019f9400-0000-4000-8000-000000000001',
  '019f9400-0000-4000-8000-000000000002',
];

test('creates one read-only cancellation inspection command with caller-bound request identity', () => {
  let index = 0;
  const command = createRunCancellationInspectionCommand(
    'project-1',
    'run-1',
    () => uuids[index++],
  );
  assert.deepEqual(command, {
    schemaVersion: 1,
    operation: 'run.cancellation.inspect',
    request: {
      projectId: 'project-1',
      runId: 'run-1',
      requestId: 'console-request-1',
      auditEventId: '019f9400-0000-4000-8000-000000000001',
      failureAuditEventId: '019f9400-0000-4000-8000-000000000002',
      body: {
        schema: 'qinglong/run-cancellation-dispatch-inspect@v1',
      },
    },
  });
});

test('projects a validated diagnostic without transport-only nesting', () => {
  const observation = projectRunCancellationInspection({
    schemaVersion: 1,
    requestId: 'console-request-1',
    result: {
      schemaVersion: 1,
      operation: 'run.cancellation.inspect',
      diagnostic: {
        schema: 'qinglong/run-cancellation-dispatch-diagnostic@v1',
        projectId: 'project-1',
        runId: 'run-1',
        runStatus: 'running',
        runVersion: 7,
        eventSequence: 9,
        cancelRequestedAtMs: 1_700_000_000_000,
        cancelReason: 'user',
        operatorAction: 'rearm',
        dispatch: {
          attemptId: 'attempt-1',
          status: 'blocked',
          version: 3,
          dispatchCount: 2,
          lastResult: 'identity_mismatch',
          createdAtMs: 1_699_999_990_000,
          updatedAtMs: 1_700_000_000_000,
        },
      },
    },
  });
  assert.equal(observation.schema, 'qinglong/run-cancellation-inspection@v1');
  assert.equal(observation.requestId, 'console-request-1');
  assert.equal(observation.projectId, 'project-1');
  assert.equal(observation.runId, 'run-1');
  assert.equal(observation.operatorAction, 'rearm');
  assert.equal(observation.dispatch.lastResult, 'identity_mismatch');
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.hasOwn(observation, 'diagnostic'), false);
});

test('rejects a non-inspection result before projection', () => {
  assert.throws(
    () =>
      projectRunCancellationInspection({
        schemaVersion: 1,
        requestId: 'console-request-1',
        result: {
          schemaVersion: 1,
          operation: 'run.cancellation.summary',
          summary: {},
        },
      }),
    /requires an inspect result/,
  );
});
