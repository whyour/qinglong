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
const { createServer } = require('node:https');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { afterEach, test } = require('node:test');

const {
  executeClusterModelProviderCredentialManagementClient,
  validateClusterModelProviderCredentialManagementClientResult,
} = require('@qinglong/cluster-admin/model-provider-credential-management-client');
const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestPlan,
} = require('@qinglong/ai/model-provider-credential-test-connection');

const FIXTURES = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const CLI = resolve(
  __dirname,
  '../dist/model-provider-credential/modelProviderCredentialManagementClientCli.js',
);
const temporaryDirectories = [];

const bindCommand = Object.freeze({
  schemaVersion: 1,
  operation: 'provider-credential.bind',
  request: Object.freeze({
    requestId: 'request-bind-1',
    mutationId: '123e4567-e89b-42d3-a456-426614174000',
    projectId: 'project-a',
    provider: 'openai-compatible',
    expectedGeneration: 0,
    revision: 'credential-v1',
    secretRef: 'project/project-a/provider-token',
  }),
});

const auditCommand = Object.freeze({
  schemaVersion: 1,
  operation: 'provider-credential.audit.list',
  request: Object.freeze({
    requestId: 'audit-request-1',
    queryId: '219f7094-a853-4f3b-82ab-dfa08e6bd1c3',
    projectId: 'project-a',
    limit: 2,
  }),
});

const testPlanCommand = Object.freeze({
  schemaVersion: 1,
  operation: 'provider-credential.test.plan',
  request: Object.freeze({
    requestId: 'test-request-1',
    testId: '319f7094-a853-4f3b-82ab-dfa08e6bd1c4',
    projectId: 'project-a',
    provider: 'openai-compatible',
  }),
});

function testPlanResult(overrides = {}) {
  const allowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [
      {
        provider: 'openai-compatible',
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.example.test/v1/',
        revision: 'endpoint-v1',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels: 64,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  const plan = createModelProviderCredentialTestPlan({
    testId: testPlanCommand.request.testId,
    requestId: testPlanCommand.request.requestId,
    projectId: testPlanCommand.request.projectId,
    provider: testPlanCommand.request.provider,
    endpoint: allowlist.providers[0],
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    plannedAtMs: 1_000,
    expiresAtMs: 61_000,
    ...overrides,
  });
  return {
    schemaVersion: 1,
    operation: 'provider-credential.test.plan',
    status: 'created',
    plan,
  };
}

function bindResult(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'provider-credential.bind',
    status: 'created',
    credential: {
      projectId: 'project-a',
      provider: 'openai-compatible',
      generation: 1,
      action: 'bind',
      activeBindingRevision: 'credential-v1',
      activeBindingDigest: 'a'.repeat(64),
      transitionDigest: 'b'.repeat(64),
      changedAtMs: 1_001,
      ...overrides,
    },
  };
}

function auditResult(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'provider-credential.audit.list',
    audit: {
      projectId: 'project-a',
      records: [
        {
          eventId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c1',
          requestId: 'request-bind-1',
          operation: 'provider-credential.bind',
          actor: { type: 'user', id: 'owner-a' },
          fence: { projectVersion: 3, bindingVersion: 7 },
          occurredAtMs: 1_001,
        },
      ],
      nextCursor: null,
      ...overrides,
    },
  };
}

function privateWrite(filePath, value) {
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function clientFiles(port, command) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-provider-credential-client-')),
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
      endpoint: `https://localhost:${port}/api/v3/provider-credentials/management`,
      servername: 'localhost',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 2_000,
    })}\n`,
  );
  privateWrite(paths.commandFile, `${JSON.stringify(command)}\n`);
  privateWrite(
    paths.assertionFile,
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );
  return paths;
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', () => resolvePromise(server.address()));
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validates an exact content-free result against the request fence', () => {
  const result = validateClusterModelProviderCredentialManagementClientResult(
    bindResult(),
    bindCommand,
  );
  assert.equal(result.credential.generation, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secretRef|provider-token|mutationId|authenticationId/,
  );
  assert.throws(() =>
    validateClusterModelProviderCredentialManagementClientResult(
      bindResult({ projectId: 'project-b' }),
      bindCommand,
    ),
  );
  assert.throws(() =>
    validateClusterModelProviderCredentialManagementClientResult(
      { ...bindResult(), secretRef: 'must-not-leak' },
      bindCommand,
    ),
  );
});

test('sends one TLS 1.3 mTLS provider credential command', async () => {
  let observed;
  const server = createServer(
    {
      key: readFileSync(join(FIXTURES, 'server-key.pem')),
      cert: readFileSync(join(FIXTURES, 'server-cert.pem')),
      ca: readFileSync(join(FIXTURES, 'ca-cert.pem')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.once('end', () => {
        observed = {
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          authorized: request.socket.authorized,
          protocol: request.socket.getProtocol(),
          command: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        const body = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            requestId: 'http-request-1',
            result: bindResult(),
          }),
        );
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
        });
        response.end(body);
      });
    },
  );
  const address = await listen(server);
  try {
    const result = await executeClusterModelProviderCredentialManagementClient(
      clientFiles(address.port, bindCommand),
    );
    assert.equal(result.requestId, 'http-request-1');
    assert.equal(result.result.credential.generation, 1);
    assert.deepEqual(observed, {
      method: 'POST',
      path: '/api/v3/provider-credentials/management',
      authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
      authorized: true,
      protocol: 'TLSv1.3',
      command: bindCommand,
    });
  } finally {
    await close(server);
  }
});

test('validates a bounded content-free audit page and rejects widening', () => {
  const result = validateClusterModelProviderCredentialManagementClientResult(
    auditResult(),
    auditCommand,
  );
  assert.equal(result.audit.records.length, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secretRef|provider-token|bindingDigest|transitionDigest|authenticationId|openai/i,
  );
  assert.throws(() =>
    validateClusterModelProviderCredentialManagementClientResult(
      auditResult({ provider: 'openai-compatible' }),
      auditCommand,
    ),
  );
  assert.throws(() =>
    validateClusterModelProviderCredentialManagementClientResult(
      auditResult({
        nextCursor: {
          occurredAtMs: 1_001,
          eventId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c1',
        },
      }),
      auditCommand,
    ),
  );
});

test('validates the exact server-selected test plan identity', () => {
  const result = validateClusterModelProviderCredentialManagementClientResult(
    testPlanResult(),
    testPlanCommand,
  );
  assert.equal(result.plan.endpoint.maxCostMicrousd, 0);
  assert.equal(result.plan.endpoint.retryLimit, 0);
  assert.doesNotMatch(JSON.stringify(result), /secretRef|token/i);
  assert.throws(() =>
    validateClusterModelProviderCredentialManagementClientResult(
      testPlanResult({ projectId: 'project-b' }),
      testPlanCommand,
    ),
  );
  assert.throws(() =>
    validateClusterModelProviderCredentialManagementClientResult(
      { ...testPlanResult(), secretRef: 'must-not-leak' },
      testPlanCommand,
    ),
  );
});

test('client CLI exposes only private file paths and stable errors', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-provider-credential-client /);
  assert.doesNotMatch(help.stdout, /token value|secret value/i);

  const invalid = spawnSync(process.execPath, [CLI, '--assertion=value'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /USAGE_INVALID/);
  assert.doesNotMatch(invalid.stderr, /assertion=value/);
});
