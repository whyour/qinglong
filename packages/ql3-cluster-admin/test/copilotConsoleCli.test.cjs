const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { request: httpRequest } = require('node:http');
const { createServer } = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
} = require('../dist/copilot-client/client.js');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'dist', 'copilot-console', 'cli.js');
const tlsFixture = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls',
);
const credential = 'ql3c_console_' + Buffer.alloc(32, 9).toString('base64url');
const consoleOperations = [
  'inspect',
  'output',
  'run_list',
  'run_read',
  'run_event_list',
  'run_step_list',
  'task_list',
  'task_read',
  'workflow_list',
  'workflow_run_list',
  'workflow_run_read',
  'workflow_event_list',
  'workflow_step_list',
];
const runManagementOperations = [
  'run_cancellation_status',
  'run_cancellation_blocked_list',
  'run_cancellation_inspect',
];
const workerManagementOperations = ['worker_list', 'worker_inspect'];
const packageManagementOperations = ['package_list', 'package_inspect'];

function workerSummary(workerId = 'worker-a') {
  return {
    workerId,
    sessionId: 'session-a',
    generation: 2,
    sessionVersion: 5,
    lifecycle: 'online',
    compatibility: 'default_placement',
    architecture: 'arm64',
    supportTier: 'tier1',
    protocolVersion: '1.0.0',
    operatingSystem: 'linux',
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: 900,
    lastHeartbeatAtMs: 1_050,
    leaseExpiresAtMs: 2_000,
    updatedAtMs: 1_050,
    observedAtMs: 1_100,
  };
}

function packageInstallationSummary(packageName = 'ops-package') {
  return {
    installationId: 'installation-transport-hidden',
    projectId: 'project-main',
    packageName,
    packageVersion: '3.1.0',
    operation: 'upgrade',
    state: 'active',
    targetGeneration: 4,
    activeLockDigest: 'a'.repeat(64),
    previousActiveLockDigest: 'b'.repeat(64),
    recoveryAction: 'none',
    availability: 'active',
    quarantineReason: null,
    quarantineAuthorizationMode: null,
    quarantineEventDigest: null,
    quarantinedAtMs: null,
    withdrawalStatus: null,
    withdrawalReceiptDigest: null,
    withdrawalCommittedAtMs: null,
    failureReason: null,
    failedFrom: null,
    failedAtMs: null,
    version: 7,
    createdAtMs: 1_000,
    updatedAtMs: 1_100,
    recordDigest: 'c'.repeat(64),
  };
}

function privateFile(directory, name, contents) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  return fs.realpathSync(filePath);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const receive = (chunk) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      stream.off('data', receive);
      stream.off('error', reject);
      resolve(buffered.slice(0, newline));
    };
    stream.on('data', receive);
    stream.once('error', reject);
  });
}

function get(origin) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        method: 'GET',
        path: '/',
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function post(origin, token, path, body) {
  const url = new URL(origin);
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        method: 'POST',
        path,
        agent: false,
        headers: {
          authorization: `QL3-Console ${token}`,
          origin,
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(bytes.byteLength),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(text),
          });
        });
      },
    );
    request.once('error', reject);
    request.end(bytes);
  });
}

async function fixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-copilot-console-cli-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(
    {
      key: fs.readFileSync(path.join(tlsFixture, 'server-key.pem')),
      cert: fs.readFileSync(path.join(tlsFixture, 'server-cert.pem')),
      ca: fs.readFileSync(path.join(tlsFixture, 'ca-cert.pem')),
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const command =
          chunks.length === 0
            ? null
            : JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          tls: request.socket.getProtocol(),
          command,
        });
        const body =
          command?.operation === 'plugin-package.installation.list'
            ? {
                schemaVersion: 1,
                requestId: 'package-transport-hidden',
                result: {
                  schemaVersion: 1,
                  operation: 'plugin-package.installation.list',
                  installations: [packageInstallationSummary()],
                  truncated: true,
                  next: { packageName: 'ops-package' },
                },
              }
            : command?.operation === 'plugin-package.installation.inspect'
            ? {
                schemaVersion: 1,
                requestId: 'package-transport-hidden',
                result: {
                  schemaVersion: 1,
                  operation: 'plugin-package.installation.inspect',
                  installation: packageInstallationSummary(),
                },
              }
            : command?.operation === 'worker-session.list'
            ? {
                schemaVersion: 1,
                requestId: 'worker-transport-hidden',
                result: {
                  schemaVersion: 1,
                  operation: 'worker-session.list',
                  observedAtMs: 1_100,
                  workers: [workerSummary()],
                  nextCursor: 'worker-a',
                },
              }
            : command?.operation === 'worker-session.inspect'
            ? {
                schemaVersion: 1,
                requestId: 'worker-transport-hidden',
                result: {
                  schemaVersion: 1,
                  operation: 'worker-session.inspect',
                  observedAtMs: 1_100,
                  worker: {
                    ...workerSummary(),
                    runtimes: [{ name: 'node', version: '24.18.0' }],
                    declaredCapacity: {
                      cpuCores: 1,
                      memoryBytes: 268_435_456,
                      diskBytes: 1_073_741_824,
                      gpuCount: 0,
                    },
                  },
                },
              }
            : command?.operation === 'run.cancellation.summary'
            ? {
                schemaVersion: 1,
                requestId: command.request.requestId,
                result: {
                  schemaVersion: 1,
                  operation: 'run.cancellation.summary',
                  summary: {
                    schema: 'qinglong/run-cancellation-dispatch-summary@v1',
                    projectId: command.request.projectId,
                    observedAtMs: 1_700_000_000_000,
                    assessment: 'attention_required',
                    operatorAction: 'inspect',
                    dispatches: {
                      total: 1,
                      pending: 0,
                      leased: 0,
                      retryWait: 0,
                      dispatched: 0,
                      blocked: 1,
                    },
                    signals: { due: 0, expiredLease: 0 },
                    blockingResults: {
                      identityMismatch: 1,
                      pidMismatch: 0,
                      unsupported: 0,
                      invalid: 0,
                    },
                    oldestBlockedAtMs: 1_699_999_999_000,
                  },
                },
              }
            : { status: 'ready' };
        const bytes = Buffer.from(JSON.stringify(body), 'utf8');
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(bytes.byteLength),
        });
        response.end(bytes);
      });
    },
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  );
  const caFile = privateFile(
    directory,
    'ca.pem',
    fs.readFileSync(path.join(tlsFixture, 'ca-cert.pem')),
  );
  const configFile = privateFile(
    directory,
    'client.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
      endpoint: `https://localhost:${server.address().port}/`,
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 2_000,
    }),
  );
  const clientCertificateFile = privateFile(
    directory,
    'run-client.crt',
    fs.readFileSync(path.join(tlsFixture, 'client-cert.pem')),
  );
  const clientPrivateKeyFile = privateFile(
    directory,
    'run-client.key',
    fs.readFileSync(path.join(tlsFixture, 'client-key.pem')),
  );
  const runManagementConfigFile = privateFile(
    directory,
    'run-client.json',
    JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${
        server.address().port
      }/api/v3/runs/management`,
      servername: 'localhost',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 2_000,
    }),
  );
  const workerManagementConfigFile = privateFile(
    directory,
    'worker-client.json',
    JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${
        server.address().port
      }/api/v3/workers/management`,
      servername: 'localhost',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 2_000,
    }),
  );
  const packageManagementConfigFile = privateFile(
    directory,
    'package-client.json',
    JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${
        server.address().port
      }/api/v3/plugin-packages/management`,
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 2_000,
    }),
  );
  const sessionToken = randomBytes(32).toString('base64url');
  return {
    requests,
    configFile,
    credentialFile: privateFile(directory, 'credential', credential),
    sessionFile: privateFile(directory, 'session', sessionToken),
    sessionToken,
    runManagementConfigFile,
    runManagementAssertionFile: privateFile(
      directory,
      'run-assertion.jwt',
      'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJl',
    ),
    workerManagementConfigFile,
    workerManagementAssertionFile: privateFile(
      directory,
      'worker-assertion.jwt',
      'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJl',
    ),
    packageManagementConfigFile,
    packageManagementAssertionFile: privateFile(
      directory,
      'package-assertion.jwt',
      'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJl',
    ),
  };
}

test('CLI exposes deterministic help and a low-sensitive failure surface', async () => {
  const usage = [
    'Usage:',
    '  ql3-copilot-console --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--port=0..65535]',
    '  ql3-copilot-console --check --config /absolute/client.json --credential /absolute/credential --session /absolute/session',
    '  ql3-copilot-console --container-published-loopback --port=1024..65535 --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--check]',
    '  Optional Run reads: --run-management-config /absolute/run-client.json --run-management-assertion /absolute/assertion.jwt',
    '  Optional Worker reads: --worker-management-config /absolute/worker-client.json --worker-management-assertion /absolute/assertion.jwt',
    '  Optional Package reads: --package-management-config /absolute/package-client.json --package-management-assertion /absolute/assertion.jwt',
    '',
    'Native mode binds 127.0.0.1. Container mode requires host-loopback port publication.',
    'The browser session key remains in a separate owner-private 0600 file.',
  ].join('\n');
  assert.deepEqual(await runCli(['--help']), {
    status: 0,
    signal: null,
    stdout: usage + '\n',
    stderr: '',
  });
  const failed = await runCli([
    '--config',
    '/private/operator/client-secret.json',
    '--credential',
    '/private/operator/cluster-secret',
    '--session',
    '/private/operator/browser-secret',
  ]);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.deepEqual(JSON.parse(failed.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-copilot-console',
    event: 'process_failed',
  });
  assert.doesNotMatch(
    failed.stderr,
    /client-secret|cluster-secret|browser-secret/,
  );
});

test('preflight proves private authority and unauthenticated TLS 1.3 readiness', async (t) => {
  const value = await fixture(t);
  const result = await runCli([
    '--check',
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-copilot-console',
    event: 'preflight_checked',
    ready: true,
    networkBoundary: 'host-loopback',
    publishedHostAddress: '127.0.0.1',
    browserCredential: 'forbidden',
    clusterCredential: 'server_only',
    runManagementAuthority: 'disabled',
    workerManagementAuthority: 'disabled',
    packageManagementAuthority: 'disabled',
    operations: consoleOperations,
    mutation: false,
  });
  assert.deepEqual(value.requests, [
    {
      method: 'GET',
      path: '/readyz',
      authorization: undefined,
      tls: 'TLSv1.3',
      command: null,
    },
  ]);
});

test('preflight enables exactly three optional Run management reads only when both private files are explicit', async (t) => {
  const value = await fixture(t);
  const result = await runCli([
    '--check',
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
    '--run-management-config',
    value.runManagementConfigFile,
    '--run-management-assertion',
    value.runManagementAssertionFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const fact = JSON.parse(result.stdout);
  assert.equal(fact.runManagementAuthority, 'server_only');
  assert.deepEqual(fact.operations, [
    'inspect',
    'output',
    ...runManagementOperations,
    ...consoleOperations.slice(2),
  ]);
  assert.equal(fact.mutation, false);
  assert.equal(value.requests.length, 1);

  const incomplete = await runCli([
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
    '--run-management-config',
    value.runManagementConfigFile,
  ]);
  assert.equal(incomplete.status, 64);
  assert.doesNotMatch(incomplete.stderr, /ql3-copilot-console-cli-/);
});

test('preflight enables exactly two Worker reads only with canonical config and assertion', async (t) => {
  const value = await fixture(t);
  const result = await runCli([
    '--check',
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
    '--worker-management-config',
    value.workerManagementConfigFile,
    '--worker-management-assertion',
    value.workerManagementAssertionFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const fact = JSON.parse(result.stdout);
  assert.equal(fact.runManagementAuthority, 'disabled');
  assert.equal(fact.workerManagementAuthority, 'server_only');
  assert.deepEqual(fact.operations, [
    'inspect',
    'output',
    ...workerManagementOperations,
    ...consoleOperations.slice(2),
  ]);
  assert.equal(value.requests.length, 1);

  const incomplete = await runCli([
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
    '--worker-management-config',
    value.workerManagementConfigFile,
  ]);
  assert.equal(incomplete.status, 64);
});

test('preflight enables exactly two Package reads only with canonical config and assertion', async (t) => {
  const value = await fixture(t);
  const result = await runCli([
    '--check',
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
    '--package-management-config',
    value.packageManagementConfigFile,
    '--package-management-assertion',
    value.packageManagementAssertionFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const fact = JSON.parse(result.stdout);
  assert.equal(fact.runManagementAuthority, 'disabled');
  assert.equal(fact.workerManagementAuthority, 'disabled');
  assert.equal(fact.packageManagementAuthority, 'server_only');
  assert.deepEqual(fact.operations, [
    'inspect',
    'output',
    ...packageManagementOperations,
    ...consoleOperations.slice(2),
  ]);
  assert.equal(value.requests.length, 1);

  const incomplete = await runCli([
    '--config',
    value.configFile,
    '--credential',
    value.credentialFile,
    '--session',
    value.sessionFile,
    '--package-management-config',
    value.packageManagementConfigFile,
  ]);
  assert.equal(incomplete.status, 64);
});

test('serve mode starts an ephemeral loopback origin and shuts down cleanly', async (t) => {
  const value = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      cliPath,
      '--config',
      value.configFile,
      '--credential',
      value.credentialFile,
      '--session',
      value.sessionFile,
      '--port=0',
    ],
    { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  const started = JSON.parse(await firstLine(child.stdout));
  assert.equal(started.event, 'started');
  assert.match(started.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.deepEqual(started.operations, consoleOperations);
  assert.equal(started.mutation, false);
  assert.equal(started.runManagementAuthority, 'disabled');
  assert.equal(started.workerManagementAuthority, 'disabled');
  assert.equal(started.packageManagementAuthority, 'disabled');
  assert.equal(started.networkBoundary, 'host-loopback');
  assert.equal(started.publishedHostAddress, '127.0.0.1');
  const shell = await get(started.origin);
  assert.equal(shell.statusCode, 200);
  assert.match(shell.body, /Cluster field ledger/);
  child.kill('SIGTERM');
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  assert.deepEqual(result, { status: 0, signal: null });
});

test('serve mode forwards one explicit status click through the optional mTLS Run authority', async (t) => {
  const value = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      cliPath,
      '--config',
      value.configFile,
      '--credential',
      value.credentialFile,
      '--session',
      value.sessionFile,
      '--run-management-config',
      value.runManagementConfigFile,
      '--run-management-assertion',
      value.runManagementAssertionFile,
      '--port=0',
    ],
    { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  const started = JSON.parse(await firstLine(child.stdout));
  assert.equal(started.runManagementAuthority, 'server_only');
  const response = await post(
    started.origin,
    value.sessionToken,
    '/api/v1/run-management/cancellation-status',
    {
      schema: 'qinglong/cluster-copilot-console-read-request@v1',
      operation: 'run_cancellation_status',
      projectId: 'project-main',
      requestId: 'console-status-1',
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.result.result.schema,
    'qinglong/run-cancellation-status@v1',
  );
  assert.equal(response.body.result.result.assessment, 'attention_required');
  assert.equal(response.body.result.result.operatorAction, 'inspect');
  assert.equal(response.body.result.result.dispatches.blocked, 1);
  const management = value.requests.find(
    (request) => request.path === '/api/v3/runs/management',
  );
  assert.equal(management.method, 'POST');
  assert.equal(management.command.operation, 'run.cancellation.summary');
  assert.equal(management.command.request.requestId, 'console-status-1');
  assert.match(management.authorization, /^Bearer [A-Za-z0-9_-]+\./);
  child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  assert.deepEqual(exit, { status: 0, signal: null });
});

test('serve mode performs one canonical Worker page read without exposing transport identity', async (t) => {
  const value = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      cliPath,
      '--config',
      value.configFile,
      '--credential',
      value.credentialFile,
      '--session',
      value.sessionFile,
      '--worker-management-config',
      value.workerManagementConfigFile,
      '--worker-management-assertion',
      value.workerManagementAssertionFile,
      '--port=0',
    ],
    { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  const started = JSON.parse(await firstLine(child.stdout));
  assert.equal(started.workerManagementAuthority, 'server_only');
  const response = await post(
    started.origin,
    value.sessionToken,
    '/api/v1/worker-management/workers',
    {
      schema: 'qinglong/cluster-copilot-console-read-request@v1',
      operation: 'worker_list',
      projectId: 'project-main',
      requestId: 'console-worker-list-1',
      afterWorkerId: null,
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.result.result.schema,
    'qinglong/worker-session-list@v1',
  );
  assert.equal(response.body.result.result.count, 1);
  assert.equal(response.body.result.result.nextAfterWorkerId, 'worker-a');
  assert.equal(
    JSON.stringify(response.body).includes('worker-transport-hidden'),
    false,
  );
  const management = value.requests.find(
    (request) => request.path === '/api/v3/workers/management',
  );
  assert.equal(management.method, 'POST');
  assert.equal(management.command.operation, 'worker-session.list');
  assert.equal(
    management.command.request.inspectionId,
    'console-worker-list-1',
  );
  child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  assert.deepEqual(exit, { status: 0, signal: null });
});

test('serve mode performs one canonical Package page read without exposing durable identity', async (t) => {
  const value = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      cliPath,
      '--config',
      value.configFile,
      '--credential',
      value.credentialFile,
      '--session',
      value.sessionFile,
      '--package-management-config',
      value.packageManagementConfigFile,
      '--package-management-assertion',
      value.packageManagementAssertionFile,
      '--port=0',
    ],
    { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  const started = JSON.parse(await firstLine(child.stdout));
  assert.equal(started.packageManagementAuthority, 'server_only');
  const response = await post(
    started.origin,
    value.sessionToken,
    '/api/v1/package-management/installations',
    {
      schema: 'qinglong/cluster-copilot-console-read-request@v1',
      operation: 'package_list',
      projectId: 'project-main',
      requestId: 'console-package-list-1',
      afterPackageName: null,
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.result.result.schema,
    'qinglong/plugin-package-installation-list@v1',
  );
  assert.equal(response.body.result.result.count, 1);
  assert.equal(response.body.result.result.nextAfterPackageName, 'ops-package');
  const encoded = JSON.stringify(response.body);
  assert.equal(encoded.includes('package-transport-hidden'), false);
  assert.equal(encoded.includes('installation-transport-hidden'), false);
  assert.equal(encoded.includes('recordDigest'), false);
  const management = value.requests.find(
    (request) => request.path === '/api/v3/plugin-packages/management',
  );
  assert.equal(management.method, 'POST');
  assert.equal(
    management.command.operation,
    'plugin-package.installation.list',
  );
  assert.equal(
    management.command.request.inspectionId,
    'console-package-list-1',
  );
  assert.equal(management.command.request.limit, 16);
  child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  assert.deepEqual(exit, { status: 0, signal: null });
});

test('container mode requires an explicit publish port before any authority read', async () => {
  const result = await runCli([
    '--container-published-loopback',
    '--config',
    '/private/client.json',
    '--credential',
    '/private/credential',
    '--session',
    '/private/session',
  ]);
  assert.equal(result.status, 64);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /container-published-loopback/);
  assert.doesNotMatch(result.stderr, /\/private\//);
});
