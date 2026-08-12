'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  validateClusterRunManagementClientResult,
} = require('@qinglong/cluster-admin/run-management-client');
const {
  normalizeClusterRunManagementCommand,
} = require('@qinglong/cluster-admin/run-management-transport');
const {
  ClusterPluginPackageManagementClientRequestError,
} = require('@qinglong/cluster-admin/plugin-package-management-client');

const command = normalizeClusterRunManagementCommand({
  schemaVersion: 1,
  operation: 'run.retry',
  request: {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'request-1',
    auditEventId: '019f9400-0000-4000-8000-000000000001',
    failureAuditEventId: '019f9400-0000-4000-8000-000000000002',
    body: {
      schema: 'qinglong/run-manual-retry@v1',
      mutationId: '019f9400-0000-4000-8000-000000000003',
      expectedRunVersion: 7,
      expectedRunStatus: 'failed',
    },
  },
});

const stopCommand = normalizeClusterRunManagementCommand({
  schemaVersion: 1,
  operation: 'run.stop',
  request: {
    projectId: 'project-1',
    runId: 'run-1',
    requestId: 'request-stop-1',
    auditEventId: '019f9400-0000-4000-8000-000000000021',
    failureAuditEventId: '019f9400-0000-4000-8000-000000000022',
    body: {
      schema: 'qinglong/run-cancellation@v1',
      mutationId: '019f9400-0000-4000-8000-000000000023',
    },
  },
});

function response(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'run.retry',
    retry: {
      schema: 'qinglong/run-manual-retry@v1',
      status: 'accepted',
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      sourceRunStatus: 'failed',
      sourceRunVersion: 7,
      runId: '019f9400-0000-4000-8000-000000000010',
      retryOfRunId: 'source-run-1',
      taskId: 'task-1',
      taskRevision: `qltd:v1:1:${'a'.repeat(64)}`,
      attemptId: '019f9400-0000-4000-8000-000000000011',
      runStatus: 'queued',
      runVersion: 2,
      eventSequence: 2,
      executorType: 'remote_worker',
      executionRevisionDigest: 'b'.repeat(64),
      createdAtMs: 1_000_000,
      ...overrides,
    },
  };
}

test('validates one low-sensitive retry response against the request fence', () => {
  assert.deepEqual(
    validateClusterRunManagementClientResult(response(), command),
    response(),
  );
});

test('rejects response target, execution placement and shape drift', () => {
  for (const candidate of [
    response({ projectId: 'project-2' }),
    response({ executorType: 'local_process' }),
    response({ sourceRunVersion: 8 }),
    { ...response(), principal: { type: 'user', id: 'operator-1' } },
  ]) {
    assert.throws(
      () => validateClusterRunManagementClientResult(candidate, command),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});

test('validates one low-sensitive stop response against the request target', () => {
  const value = {
    schemaVersion: 1,
    operation: 'run.stop',
    stop: {
      schema: 'qinglong/run-cancellation@v1',
      status: 'accepted',
      projectId: 'project-1',
      runId: 'run-1',
      runStatus: 'running',
      runVersion: 5,
      eventSequence: 7,
      cancelRequestedAtMs: 1_000_000,
      cancelReason: 'user',
    },
  };
  assert.deepEqual(
    validateClusterRunManagementClientResult(value, stopCommand),
    value,
  );
  for (const drift of [
    { ...value, stop: { ...value.stop, projectId: 'project-2' } },
    { ...value, stop: { ...value.stop, runId: 'run-2' } },
    { ...value, operation: 'run.retry' },
  ]) {
    assert.throws(
      () => validateClusterRunManagementClientResult(drift, stopCommand),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});
