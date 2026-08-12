'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterRunManagementTransportAuthenticationError,
  ClusterRunManagementTransportRequestError,
  createClusterRunManagementTransport,
  normalizeClusterRunManagementCommand,
} = require('@qinglong/cluster-admin/run-management-transport');

const NOW = 1_000_000;

function principal(overrides = {}) {
  return {
    subject: { type: 'user', id: 'operator-1' },
    authenticationId: 'oidc:run-management-1',
    authenticatedAtMs: 999_000,
    expiresAtMs: 1_100_000,
    assurance: 'multi_factor',
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'run.retry',
    request: {
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'request-1',
      auditEventId: '019f9300-0000-4000-8000-000000000001',
      failureAuditEventId: '019f9300-0000-4000-8000-000000000002',
      body: {
        schema: 'qinglong/run-manual-retry@v1',
        mutationId: '019f9300-0000-4000-8000-000000000003',
        expectedRunVersion: 7,
        expectedRunStatus: 'failed',
      },
      ...overrides,
    },
  };
}

function retryResult() {
  return {
    status: 'accepted',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    sourceRunStatus: 'failed',
    sourceRunVersion: 7,
    runId: '019f9300-0000-4000-8000-000000000010',
    retryOfRunId: 'source-run-1',
    taskId: 'task-1',
    taskRevision: `qltd:v1:1:${'a'.repeat(64)}`,
    attemptId: '019f9300-0000-4000-8000-000000000011',
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'remote_worker',
    executionRevisionDigest: 'b'.repeat(64),
    createdAtMs: NOW,
  };
}

function stopCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'run.stop',
    request: {
      projectId: 'project-1',
      runId: 'run-1',
      requestId: 'request-stop-1',
      auditEventId: '019f9300-0000-4000-8000-000000000021',
      failureAuditEventId: '019f9300-0000-4000-8000-000000000022',
      body: {
        schema: 'qinglong/run-cancellation@v1',
        mutationId: '019f9300-0000-4000-8000-000000000023',
      },
      ...overrides,
    },
  };
}

function stopResult() {
  return {
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: NOW,
    cancelReason: 'user',
  };
}

test('routes one exact strong User retry and emits the shared response', async () => {
  const calls = [];
  const transport = createClusterRunManagementTransport({
    now: () => NOW,
    service: {
      async retry(request) {
        calls.push(request);
        return retryResult();
      },
      async stop() {
        return stopResult();
      },
    },
  });
  const result = await transport.execute(command(), {
    authenticate: async () => principal(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mutationId, command().request.body.mutationId);
  assert.equal(calls[0].principal.assurance, 'multi_factor');
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'run.retry',
    retry: {
      schema: 'qinglong/run-manual-retry@v1',
      ...retryResult(),
    },
  });
});

test('routes one exact strong User stop and emits the shared response', async () => {
  const calls = [];
  const transport = createClusterRunManagementTransport({
    now: () => NOW,
    service: {
      async retry() {
        return retryResult();
      },
      async stop(request) {
        calls.push(request);
        return stopResult();
      },
    },
  });
  const result = await transport.execute(stopCommand(), {
    authenticate: async () => principal({ assurance: 'hardware' }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 'run-1');
  assert.equal(calls[0].mutationId, stopCommand().request.body.mutationId);
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'run.stop',
    stop: {
      schema: 'qinglong/run-cancellation@v1',
      ...stopResult(),
    },
  });
});

test('rejects weak or non-User identity before service authority', async () => {
  let called = false;
  const transport = createClusterRunManagementTransport({
    now: () => NOW,
    service: {
      async retry() {
        called = true;
        return retryResult();
      },
      async stop() {
        return stopResult();
      },
    },
  });
  await assert.rejects(
    transport.execute(command(), {
      authenticate: async () => principal({ assurance: 'single_factor' }),
    }),
    ClusterRunManagementTransportAuthenticationError,
  );
  await assert.rejects(
    transport.execute(command(), {
      authenticate: async () =>
        principal({ subject: { type: 'agent', id: 'agent-1' } }),
    }),
    ClusterRunManagementTransportAuthenticationError,
  );
  assert.equal(called, false);
});

test('rejects widened commands and ambiguous audit identity', () => {
  assert.throws(
    () =>
      normalizeClusterRunManagementCommand({
        ...command(),
        principal: principal(),
      }),
    ClusterRunManagementTransportRequestError,
  );
  assert.throws(
    () =>
      normalizeClusterRunManagementCommand(
        command({ failureAuditEventId: command().request.auditEventId }),
      ),
    ClusterRunManagementTransportRequestError,
  );
  assert.throws(
    () =>
      normalizeClusterRunManagementCommand(
        command({
          body: { ...command().request.body, expectedRunStatus: 'lost' },
        }),
      ),
    ClusterRunManagementTransportRequestError,
  );
  assert.throws(
    () =>
      normalizeClusterRunManagementCommand(
        stopCommand({
          body: { ...stopCommand().request.body, mutationId: 'weak' },
        }),
      ),
    ClusterRunManagementTransportRequestError,
  );
});
