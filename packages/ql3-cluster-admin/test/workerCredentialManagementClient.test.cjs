const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  executeClusterWorkerCredentialManagementClient,
  validateClusterWorkerCredentialManagementClientResult,
} = require('@qinglong/cluster-admin/worker-credential-management-client');

const CLIENT_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/client-key.pem',
);
const CLIENT_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/client-cert.pem',
);
const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const CA_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const temporaryDirectories = [];

const CLI = resolve(
  __dirname,
  '../dist/worker-credential/workerCredentialManagementClientCli.js',
);

const subject = Object.freeze({ type: 'user', id: 'operator-a' });
const plan = Object.freeze({
  actionRef: 'worker-credential:worker-1:rotate:1',
  authorityProjectId: 'cluster-authority',
  action: 'rotate',
  target: Object.freeze({
    deliveryId: 'delivery-1',
    workerId: 'worker-1',
    credentialId: 'credential-2',
    previousCredentialId: 'credential-1',
    credentialNotBeforeAtMs: 1_000,
    credentialExpiresAtMs: 2_000,
    deploymentTargetDigest: 'a'.repeat(64),
    deploymentGeneration: 'generation-2',
  }),
  requestedBy: subject,
  plannedAtMs: 900,
  expiresAtMs: 1_800,
  previewDigest: 'b'.repeat(64),
  planDigest: 'c'.repeat(64),
});
const approval = Object.freeze({
  id: 'approval-1',
  projectId: 'cluster-authority',
  version: 2,
  state: 'approved',
  risk: 'high',
  decisionMode: 'four_eyes',
  requestedBy: subject,
  requestedAtMs: 910,
  expiresAtMs: 1_800,
  decision: 'approved',
  decisionReasonCode: 'reviewed',
  decidedBy: Object.freeze({ type: 'user', id: 'reviewer-b' }),
  decidedAtMs: 920,
  dispatchId: null,
  consumedAtMs: null,
  actionType: 'worker_credential.delivery.rotate',
  actionRef: plan.actionRef,
  actionDigest: 'd'.repeat(64),
  previewDigest: plan.previewDigest,
});

function command(operation) {
  return {
    operation,
    request: {},
  };
}

function privateWrite(filePath, value) {
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function clientFiles(options = {}) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-worker-client-')),
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
  privateWrite(caFile, readFileSync(CA_CERT));
  privateWrite(clientCertificateFile, readFileSync(CLIENT_CERT));
  privateWrite(
    clientPrivateKeyFile,
    readFileSync(options.mismatchedKey ? SERVER_KEY : CLIENT_KEY),
  );
  const config = {
    schemaVersion: 1,
    endpoint:
      'https://manager.example.test:8444/api/v3/worker-credentials/management',
    servername: 'manager.example.test',
    caFile,
    ...(options.omitClientIdentity
      ? {}
      : { clientCertificateFile, clientPrivateKeyFile }),
    requestTimeoutMs: 1_000,
  };
  privateWrite(paths.configFile, `${JSON.stringify(config)}\n`);
  privateWrite(
    paths.commandFile,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'worker-credential.inspect',
      request: {
        actionRef: 'worker-credential:worker-1:rotate:1',
        authorityProjectId: 'cluster-authority',
        approvalRequestId: 'approval-worker-1',
        inspectionId: 'inspection-worker-1',
      },
    })}\n`,
  );
  privateWrite(
    paths.assertionFile,
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );
  return { paths, clientPrivateKeyFile };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validates all four low-sensitive Worker management results', () => {
  const fixtures = [
    [
      'worker-credential.plan',
      { schemaVersion: 1, operation: 'worker-credential.plan', status: 'created', plan },
    ],
    [
      'worker-credential.propose',
      {
        schemaVersion: 1,
        operation: 'worker-credential.propose',
        approvalStatus: 'created',
        plan,
        approval,
      },
    ],
    [
      'worker-credential.decide',
      {
        schemaVersion: 1,
        operation: 'worker-credential.decide',
        status: 'decided',
        approval,
      },
    ],
    [
      'worker-credential.inspect',
      {
        schemaVersion: 1,
        operation: 'worker-credential.inspect',
        plan,
        approval,
        stale: false,
      },
    ],
  ];
  for (const [operation, result] of fixtures) {
    assert.equal(
      validateClusterWorkerCredentialManagementClientResult(
        result,
        command(operation),
      ).operation,
      operation,
    );
    assert.doesNotMatch(JSON.stringify(result), /authenticationId|token|secret/i);
  }
});

test('rejects widened and secret-bearing response shapes', () => {
  assert.throws(() =>
    validateClusterWorkerCredentialManagementClientResult(
      {
        schemaVersion: 1,
        operation: 'worker-credential.inspect',
        plan: null,
        approval: { ...approval, authenticationId: 'must-not-leak' },
        stale: false,
      },
      command('worker-credential.inspect'),
    ),
  );
  assert.throws(() =>
    validateClusterWorkerCredentialManagementClientResult(
      {
        schemaVersion: 1,
        operation: 'worker-credential.execute',
        status: 'completed',
      },
      command('worker-credential.inspect'),
    ),
  );
});

test('requires one matching private client certificate identity before connect', async () => {
  {
    const files = clientFiles();
    let connects = 0;
    await assert.rejects(
      executeClusterWorkerCredentialManagementClient(files.paths, {
        async connect(target) {
          connects += 1;
          assert.deepEqual(target, {
            hostname: 'manager.example.test',
            port: 8444,
          });
          throw new Error('expected-connect-stop');
        },
      }),
      { code: 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED' },
    );
    assert.equal(connects, 1);
  }
  for (const options of [
    { omitClientIdentity: true },
    { mismatchedKey: true },
  ]) {
    const files = clientFiles(options);
    let connects = 0;
    await assert.rejects(
      executeClusterWorkerCredentialManagementClient(files.paths, {
        async connect() {
          connects += 1;
          throw new Error('must not connect');
        },
      }),
      { code: 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_CONFIG_INVALID' },
    );
    assert.equal(connects, 0);
  }
});

test('CLI exposes path-only usage and no credential material', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-worker-credential-client /);
  assert.doesNotMatch(help.stdout, /token|secret|credential-value/i);

  const invalid = spawnSync(process.execPath, [CLI, '--assertion=value'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /USAGE_INVALID/);
  assert.doesNotMatch(invalid.stderr, /assertion=value/);
});
