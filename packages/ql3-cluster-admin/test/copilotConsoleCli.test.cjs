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
const credential =
  'ql3c_console_' + Buffer.alloc(32, 9).toString('base64url');

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
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        tls: request.socket.getProtocol(),
      });
      const bytes = Buffer.from('{"status":"ready"}', 'utf8');
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(bytes.byteLength),
      });
      response.end(bytes);
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
  return {
    requests,
    configFile,
    credentialFile: privateFile(directory, 'credential', credential),
    sessionFile: privateFile(
      directory,
      'session',
      randomBytes(32).toString('base64url'),
    ),
  };
}

test('CLI exposes deterministic help and a low-sensitive failure surface', async () => {
  const usage = [
    'Usage:',
    '  ql3-copilot-console --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--port=0..65535]',
    '  ql3-copilot-console --check --config /absolute/client.json --credential /absolute/credential --session /absolute/session',
    '  ql3-copilot-console --container-published-loopback --port=1024..65535 --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--check]',
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
  assert.doesNotMatch(failed.stderr, /client-secret|cluster-secret|browser-secret/);
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
    operations: ['inspect', 'output'],
    mutation: false,
  });
  assert.deepEqual(value.requests, [
    {
      method: 'GET',
      path: '/readyz',
      authorization: undefined,
      tls: 'TLSv1.3',
    },
  ]);
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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const started = JSON.parse(await firstLine(child.stdout));
  assert.equal(started.event, 'started');
  assert.match(started.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.deepEqual(started.operations, ['inspect', 'output']);
  assert.equal(started.mutation, false);
  assert.equal(started.networkBoundary, 'host-loopback');
  assert.equal(started.publishedHostAddress, '127.0.0.1');
  const shell = await get(started.origin);
  assert.equal(shell.statusCode, 200);
  assert.match(shell.body, /Cluster field console/);
  child.kill('SIGTERM');
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  assert.deepEqual(result, { status: 0, signal: null });
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
