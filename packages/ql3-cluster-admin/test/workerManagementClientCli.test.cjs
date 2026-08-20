'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createServer } = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(
  packageRoot,
  'dist',
  'worker-management',
  'workerManagementClientCli.js',
);
const fixtureRoot = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls',
);

function privateFile(directory, name, value) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, value, { mode: 0o600 });
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

function summary(workerId) {
  return {
    workerId,
    sessionId: `session-${workerId}`,
    generation: 1,
    sessionVersion: 1,
    lifecycle: 'online',
    compatibility: 'default_placement',
    architecture: 'arm64',
    supportTier: 'tier1',
    protocolVersion: '1.0.0',
    operatingSystem: 'linux',
    maxConcurrentRuns: 1,
    availableSlots: 1,
    registeredAtMs: 900,
    lastHeartbeatAtMs: 1_000,
    leaseExpiresAtMs: 2_000,
    updatedAtMs: 1_000,
    observedAtMs: 1_100,
  };
}

test('CLI performs one canonical read per invocation and rejects mutation vocabulary', async (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-cli-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(
    {
      key: fs.readFileSync(path.join(fixtureRoot, 'server-key.pem')),
      cert: fs.readFileSync(path.join(fixtureRoot, 'server-cert.pem')),
      ca: fs.readFileSync(path.join(fixtureRoot, 'ca-cert.pem')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({
          method: request.method,
          path: request.url,
          authorized: request.socket.authorized,
          command,
        });
        const worker = summary('worker-a');
        const result =
          command.operation === 'worker-session.inspect'
            ? {
                schemaVersion: 1,
                operation: 'worker-session.inspect',
                observedAtMs: 1_100,
                worker: {
                  ...worker,
                  runtimes: [{ name: 'node', version: '24.18.0' }],
                  declaredCapacity: {
                    cpuCores: 1,
                    memoryBytes: 268_435_456,
                    diskBytes: 1_073_741_824,
                    gpuCount: 0,
                  },
                },
              }
            : {
                schemaVersion: 1,
                operation: 'worker-session.list',
                observedAtMs: 1_100,
                workers: [worker],
                nextCursor: null,
              };
        const body = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            requestId: 'server-request-hidden',
            result,
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
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, 'string');
  const caFile = privateFile(
    directory,
    'ca.pem',
    fs.readFileSync(path.join(fixtureRoot, 'ca-cert.pem')),
  );
  const clientCertificateFile = privateFile(
    directory,
    'client.crt',
    fs.readFileSync(path.join(fixtureRoot, 'client-cert.pem')),
  );
  const clientPrivateKeyFile = privateFile(
    directory,
    'client.key',
    fs.readFileSync(path.join(fixtureRoot, 'client-key.pem')),
  );
  const configFile = privateFile(
    directory,
    'client.json',
    JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${address.port}/api/v3/workers/management`,
      servername: 'localhost',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 2_000,
    }),
  );
  const assertionFile = privateFile(
    directory,
    'assertion.jwt',
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );

  const inspect = await runCli([
    'inspect',
    `--config=${configFile}`,
    `--assertion=${assertionFile}`,
    '--project=project-a',
    '--worker=worker-a',
    '--format=json',
  ]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(inspect.stderr, '');
  const inspection = JSON.parse(inspect.stdout);
  assert.equal(inspection.schema, 'qinglong/worker-session-inspection@v1');
  assert.equal(inspection.worker.workerId, 'worker-a');
  assert.equal(inspect.stdout.includes('server-request-hidden'), false);

  const list = await runCli([
    'list',
    `--config=${configFile}`,
    `--assertion=${assertionFile}`,
    '--project=project-a',
    '--format=json',
  ]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).count, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ method, path, authorized, command }) => ({
      method,
      path,
      authorized,
      operation: command.operation,
    })),
    [
      {
        method: 'POST',
        path: '/api/v3/workers/management',
        authorized: true,
        operation: 'worker-session.inspect',
      },
      {
        method: 'POST',
        path: '/api/v3/workers/management',
        authorized: true,
        operation: 'worker-session.list',
      },
    ],
  );

  const rejected = await runCli([
    'inspect',
    `--config=${configFile}`,
    `--assertion=${assertionFile}`,
    '--project=project-a',
    '--worker=worker-a',
    '--command=/private/mutation.json',
  ]);
  assert.equal(rejected.status, 64);
  assert.equal(requests.length, 2);
  assert.equal(rejected.stdout, '');
  assert.equal(JSON.parse(rejected.stderr).event, 'usage_invalid');
});

test('CLI help states its bounded read contract', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ql3-worker-client inspect/);
  assert.match(help.stdout, /ql3-worker-client list/);
  assert.match(help.stdout, /never retries, polls or auto-pages/);
  assert.doesNotMatch(help.stdout, /credential|secret|token/i);
});
