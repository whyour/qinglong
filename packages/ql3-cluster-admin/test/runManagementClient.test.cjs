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
