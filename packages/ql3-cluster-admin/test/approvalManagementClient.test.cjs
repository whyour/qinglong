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
  ClusterPluginPackageManagementClientRequestError,
} = require('@qinglong/cluster-admin/plugin-package-management-client');
const {
  executeClusterApprovalManagementClient,
  validateClusterApprovalManagementClientResult,
} = require('@qinglong/cluster-admin/approval-management-client');

const FIXTURES = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const temporaryDirectories = [];

const ACTION = Object.freeze({
  permission: 'run.start',
  actionType: 'tool.invoke',
  actionRef: 'tool:task-1',
  actionDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
});
const BASE_REQUEST = Object.freeze({
  projectId: 'default',
  approvalRequestId: 'approval-1',
  requestId: 'approval-command-1',
  auditEventId: '60000000-0000-4000-8000-000000000001',
  failureAuditEventId: '60000000-0000-4000-8000-000000000002',
});
const RECOVERY_BASE_REQUEST = Object.freeze({
  projectId: 'default',
  dispatchId: 'dispatch-1',
  requestId: 'recovery-command-1',
  auditEventId: '60000000-0000-4000-8000-000000000003',
  failureAuditEventId: '60000000-0000-4000-8000-000000000004',
});

function privateWrite(filePath, value) {
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function clientFiles() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-approval-client-')),
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
      endpoint:
        'https://approval.example.test:8447/api/v3/approvals/management',
      servername: 'approval.example.test',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 1_000,
    })}\n`,
  );
  privateWrite(
    paths.commandFile,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'approval.inspect',
      request: BASE_REQUEST,
    })}\n`,
  );
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

test('validates exact inspect results and binds them to the requested Approval', () => {
  const command = {
    schemaVersion: 1,
    operation: 'approval.inspect',
    request: BASE_REQUEST,
  };
  const found = {
    schemaVersion: 1,
    operation: 'approval.inspect',
    status: 'found',
    approval: {
      projectId: 'default',
      approvalRequestId: 'approval-1',
      version: 1,
      state: 'pending',
      risk: 'high',
      decisionMode: 'human_confirmation',
      expectedAction: ACTION,
      requestedBy: { type: 'agent', id: 'agent-1' },
      requestedAtMs: 1_000,
      expiresAtMs: 10_000,
      preview: {
        title: 'Run task',
        summary: 'Runs one reviewed task.',
        fields: [{ kind: 'identifier', label: 'Task', value: 'task-1' }],
        warnings: ['external_effect'],
      },
    },
  };
  assert.deepEqual(
    validateClusterApprovalManagementClientResult(found, command),
    found,
  );
  assert.deepEqual(
    validateClusterApprovalManagementClientResult(
      { ...found, status: 'absent', approval: null },
      command,
    ),
    { ...found, status: 'absent', approval: null },
  );
  assert.throws(
    () =>
      validateClusterApprovalManagementClientResult(
        {
          ...found,
          approval: { ...found.approval, projectId: 'other' },
        },
        command,
      ),
    ClusterPluginPackageManagementClientRequestError,
  );
});

test('validates the durable decision tuple and rejects server-side drift', () => {
  const command = {
    schemaVersion: 1,
    operation: 'approval.decide',
    request: {
      ...BASE_REQUEST,
      expectedVersion: 1,
      expectedAction: ACTION,
      decisionId: 'decision-1',
      decision: 'approved',
      reasonCode: 'reviewed',
    },
  };
  const result = {
    schemaVersion: 1,
    operation: 'approval.decide',
    status: 'decided',
    approval: {
      projectId: 'default',
      approvalRequestId: 'approval-1',
      version: 2,
      state: 'approved',
      expectedAction: ACTION,
      decisionId: 'decision-1',
      decision: 'approved',
      reasonCode: 'reviewed',
      decidedBy: { type: 'user', id: 'owner-1' },
      decidedAtMs: 2_000,
    },
  };
  assert.deepEqual(
    validateClusterApprovalManagementClientResult(result, command),
    result,
  );
  for (const approval of [
    { ...result.approval, version: 1 },
    { ...result.approval, state: 'rejected' },
    { ...result.approval, decisionId: 'decision-2' },
  ]) {
    assert.throws(
      () =>
        validateClusterApprovalManagementClientResult(
          { ...result, approval },
          command,
        ),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});

test('validates recovery inspection and binds terminal resolution to the command fence', () => {
  const recoveryAction = {
    ...ACTION,
    permission: 'secret.manage',
    actionType: 'plugin_package.secret_binding.bind',
    actionRef: 'secret-binding:1',
  };
  const inspectCommand = {
    schemaVersion: 1,
    operation: 'approval.recover.inspect',
    request: RECOVERY_BASE_REQUEST,
  };
  const recovery = {
    projectId: 'default',
    dispatchId: 'dispatch-1',
    approvalRequestId: 'approval-1',
    expectedAction: recoveryAction,
    execution: {
      status: 'recovery_required',
      version: 3,
      executionDigest: 'c'.repeat(64),
      attemptCount: 1,
      maxAttempts: 3,
      startedAtMs: 1_400,
      leaseExpiresAtMs: 1_800,
      resultMutationId: null,
      resultCode: null,
      resultDigest: null,
      completedAtMs: null,
      createdAtMs: 1_200,
      updatedAtMs: 1_400,
    },
    resolution: null,
  };
  assert.deepEqual(
    validateClusterApprovalManagementClientResult(
      {
        schemaVersion: 1,
        operation: inspectCommand.operation,
        status: 'found',
        recovery,
      },
      inspectCommand,
    ).recovery,
    recovery,
  );

  const resolveCommand = {
    schemaVersion: 1,
    operation: 'approval.recover.resolve',
    request: {
      ...RECOVERY_BASE_REQUEST,
      expectedExecutionVersion: 3,
      expectedExecutionDigest: 'c'.repeat(64),
      mutationId: 'manual-recovery-1',
      decision: 'abandon_unknown',
      evidenceDigest: 'e'.repeat(64),
      reasonCode: 'orphan_absence_verified',
    },
  };
  const resolved = {
    ...recovery,
    execution: {
      ...recovery.execution,
      status: 'blocked',
      version: 4,
      executionDigest: 'd'.repeat(64),
      leaseExpiresAtMs: null,
      resultMutationId: 'manual-recovery-1',
      resultCode: 'manual_recovery_abandoned_unknown',
      completedAtMs: 2_000,
      updatedAtMs: 2_000,
    },
    resolution: {
      mutationId: 'manual-recovery-1',
      decision: 'abandon_unknown',
      evidenceDigest: 'e'.repeat(64),
      reasonCode: 'orphan_absence_verified',
      resolvedBy: { type: 'user', id: 'owner-1' },
      resolvedAtMs: 2_000,
      resolutionDigest: 'f'.repeat(64),
    },
  };
  const result = {
    schemaVersion: 1,
    operation: resolveCommand.operation,
    status: 'resolved',
    recovery: resolved,
  };
  assert.deepEqual(
    validateClusterApprovalManagementClientResult(result, resolveCommand),
    result,
  );
  for (const changed of [
    { ...resolved, execution: { ...resolved.execution, version: 3 } },
    {
      ...resolved,
      resolution: { ...resolved.resolution, evidenceDigest: '0'.repeat(64) },
    },
  ]) {
    assert.throws(
      () =>
        validateClusterApprovalManagementClientResult(
          { ...result, recovery: changed },
          resolveCommand,
        ),
      ClusterPluginPackageManagementClientRequestError,
    );
  }
});

test('accepts only the exact Approval route before opening one mTLS connection', async () => {
  let connects = 0;
  await assert.rejects(
    executeClusterApprovalManagementClient(clientFiles(), {
      async connect(target) {
        connects += 1;
        assert.deepEqual(target, {
          hostname: 'approval.example.test',
          port: 8447,
        });
        throw new Error('expected-connect-stop');
      },
    }),
    { code: 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED' },
  );
  assert.equal(connects, 1);
});
