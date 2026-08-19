'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { afterEach, test } = require('node:test');

const {
  executeClusterRunManagementClient,
  validateClusterRunManagementClientResult,
} = require('@qinglong/cluster-admin/run-management-client');
const {
  normalizeClusterRunManagementCommand,
} = require('@qinglong/cluster-admin/run-management-transport');
const {
  ClusterPluginPackageManagementClientRequestError,
} = require('@qinglong/cluster-admin/plugin-package-management-client');

const FIXTURES = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const temporaryDirectories = [];

function privateWrite(filePath, value) {
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function clientFiles() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-run-management-client-')),
  );
  temporaryDirectories.push(directory);
  const paths = {
    configFile: join(directory, 'client.json'),
    commandFile: join(directory, 'command.json'),
    assertionFile: join(directory, 'assertion.jwt'),
  };
  const caFile = join(directory, 'ca.crt');
  const clientCertificateFile = join(directory, 'client.crt');
  const clientPrivateKeyFile = join(directory, 'client.key');
  privateWrite(caFile, readFileSync(join(FIXTURES, 'ca-cert.pem')));
  privateWrite(
    clientCertificateFile,
    readFileSync(join(FIXTURES, 'client-cert.pem')),
  );
  privateWrite(
    clientPrivateKeyFile,
    readFileSync(join(FIXTURES, 'client-key.pem')),
  );
  privateWrite(
    paths.configFile,
    `${JSON.stringify({
      schemaVersion: 1,
      endpoint: 'https://run.example.test:8448/api/v3/runs/management',
      servername: 'run.example.test',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 1_000,
    })}\n`,
  );
  privateWrite(paths.commandFile, `${JSON.stringify(command)}\n`);
  privateWrite(
    paths.assertionFile,
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );
  return paths;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

const inspectCommand = normalizeClusterRunManagementCommand({
  schemaVersion: 1,
  operation: 'run.cancellation.inspect',
  request: {
    projectId: 'project-1',
    runId: 'run-1',
    requestId: 'request-inspect-1',
    auditEventId: '019f9400-0000-4000-8000-000000000031',
    failureAuditEventId: '019f9400-0000-4000-8000-000000000032',
    body: {
      schema: 'qinglong/run-cancellation-dispatch-inspect@v1',
    },
  },
});

const summaryCommand = normalizeClusterRunManagementCommand({
  schemaVersion: 1,
  operation: 'run.cancellation.summary',
  request: {
    projectId: 'project-1',
    requestId: 'request-summary-1',
    auditEventId: '019f9400-0000-4000-8000-000000000051',
    failureAuditEventId: '019f9400-0000-4000-8000-000000000052',
    body: {
      schema: 'qinglong/run-cancellation-dispatch-summary-request@v1',
    },
  },
});

const rearmCommand = normalizeClusterRunManagementCommand({
  schemaVersion: 1,
  operation: 'run.cancellation.rearm',
  request: {
    projectId: 'project-1',
    runId: 'run-1',
    requestId: 'request-rearm-1',
    auditEventId: '019f9400-0000-4000-8000-000000000041',
    failureAuditEventId: '019f9400-0000-4000-8000-000000000042',
    body: {
      schema: 'qinglong/run-cancellation-dispatch-rearm-request@v1',
      mutationId: '019f9400-0000-4000-8000-000000000043',
      expectedDispatchVersion: 3,
      expectedLastResult: 'identity_mismatch',
      retryDelayMs: 5_000,
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

test('accepts only the exact Run route before opening one mTLS connection', async () => {
  let connects = 0;
  await assert.rejects(
    executeClusterRunManagementClient(clientFiles(), {
      async connect(target) {
        connects += 1;
        assert.deepEqual(target, {
          hostname: 'run.example.test',
          port: 8448,
        });
        throw new Error('expected-connect-stop');
      },
    }),
    { code: 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED' },
  );
  assert.equal(connects, 1);
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

test('validates a low-sensitive cancellation diagnostic and rejects capability leakage', () => {
  const value = {
    schemaVersion: 1,
    operation: 'run.cancellation.inspect',
    diagnostic: {
      schema: 'qinglong/run-cancellation-dispatch-diagnostic@v1',
      projectId: 'project-1',
      runId: 'run-1',
      runStatus: 'running',
      runVersion: 6,
      eventSequence: 8,
      cancelRequestedAtMs: 999_000,
      cancelReason: 'user',
      operatorAction: 'rearm',
      dispatch: {
        attemptId: 'attempt-1',
        status: 'blocked',
        version: 3,
        dispatchCount: 1,
        lastResult: 'identity_mismatch',
        createdAtMs: 999_100,
        updatedAtMs: 999_200,
      },
    },
  };
  assert.deepEqual(
    validateClusterRunManagementClientResult(value, inspectCommand),
    value,
  );
  for (const drift of [
    { ...value, diagnostic: { ...value.diagnostic, projectId: 'project-2' } },
    { ...value, diagnostic: { ...value.diagnostic, runId: 'run-2' } },
    {
      ...value,
      diagnostic: { ...value.diagnostic, operatorAction: 'none' },
    },
    {
      ...value,
      diagnostic: {
        ...value.diagnostic,
        dispatch: { ...value.diagnostic.dispatch, leaseOwner: 'worker-1' },
      },
    },
    {
      ...value,
      diagnostic: {
        ...value.diagnostic,
        dispatch: {
          ...value.diagnostic.dispatch,
          leaseTokenDigest: 'a'.repeat(64),
        },
      },
    },
  ]) {
    assert.throws(
      () => validateClusterRunManagementClientResult(drift, inspectCommand),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});

test('validates the fixed low-sensitive Project cancellation summary', () => {
  const value = {
    schemaVersion: 1,
    operation: 'run.cancellation.summary',
    summary: {
      schema: 'qinglong/run-cancellation-dispatch-summary@v1',
      projectId: 'project-1',
      observedAtMs: 1_000_000,
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
      oldestBlockedAtMs: 999_200,
    },
  };
  assert.deepEqual(
    validateClusterRunManagementClientResult(value, summaryCommand),
    value,
  );
  for (const summary of [
    { ...value.summary, projectId: 'project-2' },
    { ...value.summary, assessment: 'clear' },
    { ...value.summary, operatorAction: 'wait' },
    {
      ...value.summary,
      dispatches: { ...value.summary.dispatches, total: 6 },
    },
    {
      ...value.summary,
      blockingResults: {
        ...value.summary.blockingResults,
        identityMismatch: 0,
      },
    },
    { ...value.summary, oldestBlockedAtMs: 1_000_001 },
    { ...value.summary, runId: 'run-1' },
  ]) {
    assert.throws(
      () =>
        validateClusterRunManagementClientResult(
          { ...value, summary },
          summaryCommand,
        ),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});

test('binds a rearm receipt to the exact dispatch version, result and delay fences', () => {
  const value = {
    schemaVersion: 1,
    operation: 'run.cancellation.rearm',
    rearm: {
      schema: 'qinglong/run-cancellation-dispatch-rearm-receipt@v1',
      status: 'rearmed',
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      previousDispatchVersion: 3,
      dispatchVersion: 4,
      previousResult: 'identity_mismatch',
      retryDelayMs: 5_000,
      nextAttemptAtMs: 1_005_000,
      runVersion: 7,
      eventSequence: 9,
    },
  };
  assert.deepEqual(
    validateClusterRunManagementClientResult(value, rearmCommand),
    value,
  );
  for (const rearm of [
    { ...value.rearm, previousDispatchVersion: 4 },
    { ...value.rearm, dispatchVersion: 5 },
    { ...value.rearm, previousResult: 'pid_mismatch' },
    { ...value.rearm, retryDelayMs: 6_000 },
    { ...value.rearm, runId: 'run-2' },
  ]) {
    assert.throws(
      () =>
        validateClusterRunManagementClientResult(
          { ...value, rearm },
          rearmCommand,
        ),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});
