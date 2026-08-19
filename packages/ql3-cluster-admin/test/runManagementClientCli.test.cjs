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
  'run-management',
  'runManagementClientCli.js',
);
const tlsFixture = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls',
);

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

test('status mode calls only the summary operation and emits an alert exit', async (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-run-status-cli-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const caFile = privateFile(
    directory,
    'ca.pem',
    fs.readFileSync(path.join(tlsFixture, 'ca-cert.pem')),
  );
  const clientCertificateFile = privateFile(
    directory,
    'client.crt',
    fs.readFileSync(path.join(tlsFixture, 'client-cert.pem')),
  );
  const clientPrivateKeyFile = privateFile(
    directory,
    'client.key',
    fs.readFileSync(path.join(tlsFixture, 'client-key.pem')),
  );
  const requests = [];
  const server = createServer(
    {
      key: fs.readFileSync(path.join(tlsFixture, 'server-key.pem')),
      cert: fs.readFileSync(path.join(tlsFixture, 'server-cert.pem')),
      ca: fs.readFileSync(path.join(tlsFixture, 'ca-cert.pem')),
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
          authorization: request.headers.authorization,
          authorized: request.socket.authorized,
          command,
        });
        const bytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            requestId: command.request.requestId,
            result: {
              schemaVersion: 1,
              operation: 'run.cancellation.summary',
              summary: {
                schema: 'qinglong/run-cancellation-dispatch-summary@v1',
                projectId: 'project-1',
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
          }),
          'utf8',
        );
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
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, 'string');
  const configFile = privateFile(
    directory,
    'client.json',
    JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${address.port}/api/v3/runs/management`,
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
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJl',
  );

  const result = await runCli([
    `--config=${configFile}`,
    'status',
    `--assertion=${assertionFile}`,
    '--project=project-1',
    '--format=json',
  ]);

  assert.equal(result.status, 20, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema, 'qinglong/run-cancellation-status@v1');
  assert.equal(output.assessment, 'attention_required');
  assert.equal(output.severity, 'critical');
  assert.equal(output.exitCode, 20);
  assert.equal(output.dispatches.blocked, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/api/v3/runs/management');
  assert.equal(requests[0].authorized, true);
  assert.match(requests[0].authorization, /^Bearer [A-Za-z0-9_-]+\./);
  assert.equal(requests[0].command.operation, 'run.cancellation.summary');
  assert.deepEqual(requests[0].command.request.body, {
    schema: 'qinglong/run-cancellation-dispatch-summary-request@v1',
  });
  assert.equal(Object.hasOwn(requests[0].command.request, 'runId'), false);
});

test('help documents status routing and invalid projects fail before I/O', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ql3-run-client status/);
  assert.match(help.stdout, /0=clear, 10=converging, 20=attention_required/);

  const rejected = await runCli([
    'status',
    '--config=/private/client.json',
    '--assertion=/private/assertion.jwt',
    '--project=../escape',
  ]);
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout, '');
  assert.deepEqual(JSON.parse(rejected.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-run-management-client',
    event: 'usage_invalid',
    code: 'QL3_RUN_MANAGEMENT_CLIENT_USAGE_INVALID',
  });
});
