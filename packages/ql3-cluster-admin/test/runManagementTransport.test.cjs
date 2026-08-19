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

function diagnosticResult() {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 6,
    eventSequence: 8,
    cancelRequestedAtMs: NOW - 1_000,
    cancelReason: 'user',
    operatorAction: 'rearm',
    dispatch: {
      attemptId: 'attempt-1',
      status: 'blocked',
      version: 3,
      dispatchCount: 1,
      lastResult: 'identity_mismatch',
      createdAtMs: NOW - 900,
      updatedAtMs: NOW - 800,
    },
  };
}

function summaryResult() {
  return {
    projectId: 'project-1',
    observedAtMs: NOW,
    assessment: 'attention_required',
    operatorAction: 'inspect',
    dispatches: {
      total: 5,
      pending: 1,
      leased: 1,
      retryWait: 1,
      dispatched: 1,
      blocked: 1,
    },
    signals: { due: 1, expiredLease: 1 },
    blockingResults: {
      identityMismatch: 1,
      pidMismatch: 0,
      unsupported: 0,
      invalid: 0,
    },
    oldestBlockedAtMs: NOW - 800,
  };
}

function rearmResult() {
  return {
    status: 'rearmed',
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    previousDispatchVersion: 3,
    dispatchVersion: 4,
    previousResult: 'identity_mismatch',
    retryDelayMs: 5_000,
    nextAttemptAtMs: NOW + 5_000,
    runVersion: 7,
    eventSequence: 9,
  };
}

function inspectCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'run.cancellation.inspect',
    request: {
      projectId: 'project-1',
      runId: 'run-1',
      requestId: 'request-inspect-1',
      auditEventId: '019f9300-0000-4000-8000-000000000031',
      failureAuditEventId: '019f9300-0000-4000-8000-000000000032',
      body: {
        schema: 'qinglong/run-cancellation-dispatch-inspect@v1',
      },
      ...overrides,
    },
  };
}

function summaryCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'run.cancellation.summary',
    request: {
      projectId: 'project-1',
      requestId: 'request-summary-1',
      auditEventId: '019f9300-0000-4000-8000-000000000051',
      failureAuditEventId: '019f9300-0000-4000-8000-000000000052',
      body: {
        schema: 'qinglong/run-cancellation-dispatch-summary-request@v1',
      },
      ...overrides,
    },
  };
}

function rearmCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'run.cancellation.rearm',
    request: {
      projectId: 'project-1',
      runId: 'run-1',
      requestId: 'request-rearm-1',
      auditEventId: '019f9300-0000-4000-8000-000000000041',
      failureAuditEventId: '019f9300-0000-4000-8000-000000000042',
      body: {
        schema: 'qinglong/run-cancellation-dispatch-rearm-request@v1',
        mutationId: '019f9300-0000-4000-8000-000000000043',
        expectedDispatchVersion: 3,
        expectedLastResult: 'identity_mismatch',
        retryDelayMs: 5_000,
      },
      ...overrides,
    },
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
      async summarizeCancellation() {
        return summaryResult();
      },
      async inspectCancellation() {
        return diagnosticResult();
      },
      async rearmCancellation() {
        return rearmResult();
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
      async summarizeCancellation() {
        return summaryResult();
      },
      async inspectCancellation() {
        return diagnosticResult();
      },
      async rearmCancellation() {
        return rearmResult();
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
      async summarizeCancellation() {
        return summaryResult();
      },
      async inspectCancellation() {
        return diagnosticResult();
      },
      async rearmCancellation() {
        return rearmResult();
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

test('routes bounded cancellation inspection without lease capability data', async () => {
  const calls = [];
  const transport = createClusterRunManagementTransport({
    now: () => NOW,
    service: {
      async retry() { return retryResult(); },
      async stop() { return stopResult(); },
      async summarizeCancellation() { return summaryResult(); },
      async inspectCancellation(request) {
        calls.push(request);
        return diagnosticResult();
      },
      async rearmCancellation() { return rearmResult(); },
    },
  });
  const result = await transport.execute(inspectCommand(), {
    authenticate: async () => principal(),
  });
  assert.equal(calls[0].runId, 'run-1');
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'run.cancellation.inspect',
    diagnostic: {
      schema: 'qinglong/run-cancellation-dispatch-diagnostic@v1',
      ...diagnosticResult(),
    },
  });
  assert.equal(JSON.stringify(result).includes('leaseOwner'), false);
  assert.equal(JSON.stringify(result).includes('leaseToken'), false);
});

test('routes one Project-scoped cancellation summary without Run identity', async () => {
  const calls = [];
  const transport = createClusterRunManagementTransport({
    now: () => NOW,
    service: {
      async retry() { return retryResult(); },
      async stop() { return stopResult(); },
      async summarizeCancellation(request) {
        calls.push(request);
        return summaryResult();
      },
      async inspectCancellation() { return diagnosticResult(); },
      async rearmCancellation() { return rearmResult(); },
    },
  });
  const result = await transport.execute(summaryCommand(), {
    authenticate: async () => principal(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, 'project-1');
  assert.equal(Object.hasOwn(calls[0], 'runId'), false);
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'run.cancellation.summary',
    summary: {
      schema: 'qinglong/run-cancellation-dispatch-summary@v1',
      ...summaryResult(),
    },
  });
  assert.equal(JSON.stringify(result).includes('attemptId'), false);
  assert.equal(JSON.stringify(result).includes('leaseOwner'), false);
});

test('routes an exact blocked cancellation rearm receipt', async () => {
  const calls = [];
  const transport = createClusterRunManagementTransport({
    now: () => NOW,
    service: {
      async retry() { return retryResult(); },
      async stop() { return stopResult(); },
      async summarizeCancellation() { return summaryResult(); },
      async inspectCancellation() { return diagnosticResult(); },
      async rearmCancellation(request) {
        calls.push(request);
        return rearmResult();
      },
    },
  });
  const result = await transport.execute(rearmCommand(), {
    authenticate: async () => principal({ assurance: 'hardware' }),
  });
  assert.equal(calls[0].expectedDispatchVersion, 3);
  assert.equal(calls[0].expectedLastResult, 'identity_mismatch');
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'run.cancellation.rearm',
    rearm: {
      schema: 'qinglong/run-cancellation-dispatch-rearm-receipt@v1',
      ...rearmResult(),
    },
  });
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
