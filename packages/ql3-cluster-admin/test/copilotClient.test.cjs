const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createServer } = require('node:https');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'dist', 'copilot-client', 'cli.js');
const fixtureRoot = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls',
);
const caFixture = path.join(fixtureRoot, 'ca-cert.pem');
const certificateFixture = path.join(fixtureRoot, 'server-cert.pem');
const privateKeyFixture = path.join(fixtureRoot, 'server-key.pem');

const {
  CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
  ClusterCopilotClientRemoteError,
  executeClusterCopilotClient,
  executeClusterProjectApiRead,
  probeClusterCopilotClientReadiness,
  validateClusterCopilotClientConfiguration,
} = require('../dist/copilot-client/client.js');
const {
  CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA,
  normalizeClusterCopilotClientCommand,
  prepareClusterCopilotClientRequest,
  validateClusterCopilotClientResponse,
} = require('../dist/copilot-client/contracts.js');

const credential = `ql3c_credential-1_${Buffer.alloc(32, 7).toString(
  'base64url',
)}`;
const baseCommand = {
  schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
  projectId: 'project-1',
  sourceRunId: 'source-run-1',
  requestId: 'diagnosis-request-1',
};

function privateFile(directory, name, contents) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  return fs.realpathSync(filePath);
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-copilot-client-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function configuration(directory, port) {
  const caFile = privateFile(directory, 'ca.pem', fs.readFileSync(caFixture));
  return privateFile(
    directory,
    'client.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
      endpoint: `https://localhost:${port}/`,
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 2_000,
    }),
  );
}

function commandFile(directory, name, operation, extra = {}) {
  return privateFile(
    directory,
    `${name}.json`,
    JSON.stringify({ ...baseCommand, operation, ...extra }),
  );
}

function jsonResponse(response, statusCode, requestId, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    ...(requestId === null ? {} : { 'x-request-id': requestId }),
    ...headers,
  });
  response.end(bytes);
}

async function startServer(handler) {
  const server = createServer(
    {
      key: fs.readFileSync(privateKeyFixture),
      cert: fs.readFileSync(certificateFixture),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    handler,
  );
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function runCli(args) {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function diagnoseResponse(overrides = {}) {
  return {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA,
    requestId: baseCommand.requestId,
    status: 'created',
    replayed: false,
    sourceRunId: baseCommand.sourceRunId,
    diagnosisRunId: 'diagnosis-run-1',
    outcome: 'succeeded',
    stage: 'model',
    reason: null,
    outputArtifact: {
      artifactId: 'cdo:artifact-1',
      artifactDigest: 'a'.repeat(64),
    },
    ...overrides,
  };
}

function inspectionResponse(overrides = {}) {
  return {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA,
    status: 'running',
    projectId: baseCommand.projectId,
    sourceRunId: baseCommand.sourceRunId,
    requestId: baseCommand.requestId,
    diagnosisRunId: 'diagnosis-run-1',
    outcome: null,
    stage: null,
    reason: null,
    outputAvailable: false,
    admittedAtMs: 100,
    finalizedAtMs: null,
    usage: null,
    ...overrides,
  };
}

function outputResponse() {
  return {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA,
    status: 'available',
    projectId: baseCommand.projectId,
    sourceRunId: baseCommand.sourceRunId,
    requestId: baseCommand.requestId,
    diagnosisRunId: 'diagnosis-run-1',
    reference: {
      artifactId: 'cdo:artifact-1',
      artifactDigest: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      outputBytes: Buffer.byteLength('diagnosis'),
      sealedAtMs: 200,
    },
    result: {
      text: 'diagnosis',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
  };
}

function cancellationResponse() {
  return {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA,
    status: 'accepted',
    convergence: 'terminal',
    projectId: baseCommand.projectId,
    sourceRunId: baseCommand.sourceRunId,
    requestId: baseCommand.requestId,
    diagnosisRunId: 'diagnosis-run-1',
    runStatus: 'cancelled',
    outcome: 'cancelled',
    runVersion: 7,
    eventSequence: 7,
    cancelRequestedAtMs: 500,
    cancelReason: 'user',
  };
}

test('normalizes only the four bounded commands and derives exact requests', () => {
  const commands = [
    { ...baseCommand, operation: 'diagnose', traceId: 'trace-1' },
    { ...baseCommand, operation: 'inspect' },
    { ...baseCommand, operation: 'output' },
    {
      ...baseCommand,
      operation: 'cancel',
      mutationId: '11111111-1111-4111-8111-111111111111',
    },
  ];
  for (const command of commands) {
    const normalized = normalizeClusterCopilotClientCommand(command);
    assert.deepEqual(normalized, command);
    assert.equal(Object.isFrozen(normalized), true);
  }
  assert.deepEqual(prepareClusterCopilotClientRequest(commands[0]), {
    method: 'POST',
    path: '/api/v3/projects/project-1/runs/source-run-1/copilot/failure-diagnoses',
    requestId: baseCommand.requestId,
    body: {
      schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
      traceId: 'trace-1',
    },
    acceptedStatusCodes: [200, 201],
  });
  assert.deepEqual(
    prepareClusterCopilotClientRequest(commands[2], 'transport-read-1'),
    {
      method: 'GET',
      path: '/api/v3/projects/project-1/runs/source-run-1/copilot/failure-diagnoses/diagnosis-request-1/output',
      requestId: 'transport-read-1',
      body: null,
      acceptedStatusCodes: [200],
    },
  );
  assert.throws(() =>
    normalizeClusterCopilotClientCommand({ ...commands[0], model: 'private' }),
  );
  assert.throws(() =>
    prepareClusterCopilotClientRequest(commands[1], '../invalid'),
  );
});

test('validates exact target-bound response state for every operation', () => {
  const diagnose = {
    ...baseCommand,
    operation: 'diagnose',
    traceId: 'trace-1',
  };
  const inspect = { ...baseCommand, operation: 'inspect' };
  const output = { ...baseCommand, operation: 'output' };
  const cancel = {
    ...baseCommand,
    operation: 'cancel',
    mutationId: '11111111-1111-4111-8111-111111111111',
  };
  assert.equal(
    validateClusterCopilotClientResponse(diagnoseResponse(), diagnose).status,
    'created',
  );
  assert.equal(
    validateClusterCopilotClientResponse(inspectionResponse(), inspect).status,
    'running',
  );
  assert.equal(
    validateClusterCopilotClientResponse(
      inspectionResponse({
        status: 'terminal',
        outcome: 'succeeded',
        stage: 'model',
        outputAvailable: true,
        finalizedAtMs: 200,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          currency: 'USD',
          costMicros: 7,
        },
      }),
      inspect,
    ).status,
    'terminal',
  );
  assert.equal(
    validateClusterCopilotClientResponse(outputResponse(), output).result.text,
    'diagnosis',
  );
  assert.equal(
    validateClusterCopilotClientResponse(cancellationResponse(), cancel).status,
    'accepted',
  );
  assert.equal(
    validateClusterCopilotClientResponse(
      diagnoseResponse({ status: 'existing', replayed: true }),
      diagnose,
    ).replayed,
    true,
  );
  assert.equal(
    validateClusterCopilotClientResponse(
      {
        ...cancellationResponse(),
        status: 'already_requested',
        convergence: 'model_in_flight',
        runStatus: 'running',
        outcome: null,
        runVersion: 6,
        eventSequence: 6,
      },
      cancel,
    ).convergence,
    'model_in_flight',
  );
  assert.throws(() =>
    validateClusterCopilotClientResponse(
      diagnoseResponse({ schema: 'qinglong/drift@v1' }),
      diagnose,
    ),
  );
  assert.throws(() =>
    validateClusterCopilotClientResponse(
      diagnoseResponse({ projectId: 'widened' }),
      diagnose,
    ),
  );
  assert.throws(() =>
    validateClusterCopilotClientResponse(
      inspectionResponse({ projectId: 'other-project' }),
      inspect,
    ),
  );
  const invalidOutput = outputResponse();
  invalidOutput.reference.outputBytes += 1;
  assert.throws(() =>
    validateClusterCopilotClientResponse(invalidOutput, output),
  );
  assert.throws(() =>
    validateClusterCopilotClientResponse(cancellationResponse(), {
      ...cancel,
      requestId: 'other-request',
    }),
  );
});

test('uses TLS 1.3, Bearer credential and exact request identities end to end', async (t) => {
  const seen = [];
  const server = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        requestId: request.headers['x-request-id'],
        body: body === '' ? null : JSON.parse(body),
        peerCertificate: request.socket.getPeerCertificate(),
      });
      const requestId = request.headers['x-request-id'];
      if (request.url === '/readyz') {
        assert.equal(request.headers.authorization, undefined);
        jsonResponse(response, 200, null, { status: 'ready' });
      } else if (
        request.method === 'POST' &&
        request.url.endsWith('/cancellation')
      ) {
        jsonResponse(response, 202, requestId, cancellationResponse());
      } else if (request.method === 'POST') {
        jsonResponse(response, 201, requestId, diagnoseResponse());
      } else if (request.url.endsWith('/output')) {
        jsonResponse(response, 200, requestId, outputResponse());
      } else {
        jsonResponse(response, 200, requestId, inspectionResponse());
      }
    });
  });
  t.after(() => server.close());
  const directory = temporaryDirectory(t);
  const configFile = configuration(directory, server.port);
  const credentialFile = privateFile(directory, 'credential', credential);
  assert.deepEqual(validateClusterCopilotClientConfiguration(configFile), {
    schemaVersion: 1,
    transport: 'https',
    clientCertificate: 'forbidden',
  });
  assert.deepEqual(await probeClusterCopilotClientReadiness(configFile), {
    schemaVersion: 1,
    transport: 'https',
    ready: true,
  });

  const operations = [
    ['diagnose', { traceId: 'trace-1' }, baseCommand.requestId],
    ['inspect', {}, 'transport-read-1'],
    ['output', {}, 'transport-read-2'],
    [
      'cancel',
      { mutationId: '11111111-1111-4111-8111-111111111111' },
      '11111111-1111-4111-8111-111111111111',
    ],
  ];
  for (const [operation, extra, expectedRequestId] of operations) {
    const result = await executeClusterCopilotClient(
      {
        configFile,
        commandFile: commandFile(directory, operation, operation, extra),
        credentialFile,
      },
      { createRequestId: () => expectedRequestId },
    );
    assert.equal(result.operation, operation);
    assert.equal(result.requestId, expectedRequestId);
  }
  assert.equal(seen.length, 5);
  for (const request of seen.slice(1)) {
    assert.equal(request.authorization, `Bearer ${credential}`);
    assert.equal(request.peerCertificate.subject, undefined);
  }
  assert.deepEqual(seen[1].body, {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
    traceId: 'trace-1',
  });
  assert.equal(seen[2].body, null);
  assert.equal(seen[3].body, null);
  assert.deepEqual(seen[4].body, {
    schema: 'qinglong/run-cancellation@v1',
    mutationId: '11111111-1111-4111-8111-111111111111',
  });
});

test('reuses the credential-safe TLS boundary for fixed Project API reads only', async (t) => {
  const seen = [];
  const server = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        requestId: request.headers['x-request-id'],
        bodyBytes: Buffer.concat(chunks).byteLength,
        tls: request.socket.getProtocol(),
      });
      jsonResponse(response, 200, request.headers['x-request-id'], {
        runs: [],
        hasMore: false,
      });
    });
  });
  t.after(() => server.close());
  const directory = temporaryDirectory(t);
  const execution = {
    configFile: configuration(directory, server.port),
    credentialFile: privateFile(directory, 'credential', credential),
    path: '/api/v3/projects/project-1/runs?limit=32',
    requestId: 'console-read-1',
  };
  assert.deepEqual(await executeClusterProjectApiRead(execution), {
    schemaVersion: 1,
    requestId: 'console-read-1',
    result: { runs: [], hasMore: false },
  });
  assert.deepEqual(seen, [
    {
      method: 'GET',
      url: '/api/v3/projects/project-1/runs?limit=32',
      authorization: `Bearer ${credential}`,
      requestId: 'console-read-1',
      bodyBytes: 0,
      tls: 'TLSv1.3',
    },
  ]);
  await assert.rejects(
    executeClusterProjectApiRead({
      ...execution,
      path: '/api/v3/projects/project-1/runs/run-1/cancellation',
    }),
    { code: 'QL3_CLUSTER_COPILOT_CLIENT_REQUEST_FAILED' },
  );
  await assert.rejects(
    executeClusterProjectApiRead({
      ...execution,
      path: 'https://attacker.example/api/v3/projects/project-1/runs',
    }),
    { code: 'QL3_CLUSTER_COPILOT_CLIENT_REQUEST_FAILED' },
  );
});

test('fails closed on weak files, request-id drift and low-sensitive remote errors', async (t) => {
  let mode = 'readiness-drift';
  const server = await startServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (mode === 'readiness-drift') {
        jsonResponse(response, 200, null, { status: 'ready', widened: true });
        return;
      }
      if (mode === 'drift') {
        jsonResponse(response, 201, 'wrong-request', diagnoseResponse());
        return;
      }
      jsonResponse(
        response,
        429,
        request.headers['x-request-id'],
        { code: 'copilot_rate_limited', reason: 'private detail' },
        { 'retry-after': '30' },
      );
    });
  });
  t.after(() => server.close());
  const directory = temporaryDirectory(t);
  const configFile = configuration(directory, server.port);
  const command = commandFile(directory, 'diagnose', 'diagnose', {
    traceId: 'trace-1',
  });
  const credentialFile = privateFile(directory, 'credential', credential);
  const paths = { configFile, commandFile: command, credentialFile };
  await assert.rejects(probeClusterCopilotClientReadiness(configFile), {
    code: 'QL3_CLUSTER_COPILOT_CLIENT_REQUEST_FAILED',
  });

  mode = 'drift';
  await assert.rejects(executeClusterCopilotClient(paths), {
    code: 'QL3_CLUSTER_COPILOT_CLIENT_REQUEST_FAILED',
  });

  mode = 'remote';
  await assert.rejects(executeClusterCopilotClient(paths), (error) => {
    assert.equal(error instanceof ClusterCopilotClientRemoteError, true);
    assert.equal(error.statusCode, 429);
    assert.equal(error.responseCode, 'copilot_rate_limited');
    assert.equal(error.requestId, baseCommand.requestId);
    assert.equal(error.retryAfterSeconds, 30);
    assert.equal(JSON.stringify(error).includes('private detail'), false);
    return true;
  });

  const cli = await runCli([
    `--config=${configFile}`,
    `--command=${command}`,
    `--credential=${credentialFile}`,
  ]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.deepEqual(JSON.parse(cli.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-copilot-client',
    event: 'command_failed',
    code: 'QL3_CLUSTER_COPILOT_CLIENT_REMOTE_REJECTED',
    statusCode: 429,
    responseCode: 'copilot_rate_limited',
    requestId: baseCommand.requestId,
    retryAfterSeconds: 30,
  });
  assert.equal(cli.stderr.includes(credential), false);
  assert.equal(cli.stderr.includes('private detail'), false);
  assert.equal(cli.stderr.includes(directory), false);

  fs.chmodSync(credentialFile, 0o644);
  await assert.rejects(executeClusterCopilotClient(paths), {
    code: 'QL3_CLUSTER_COPILOT_CLIENT_CONFIG_INVALID',
  });
});

test('CLI help, usage and explicit output success remain deterministic', async (t) => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-copilot-client /);
  assert.equal(help.stderr, '');
  const usage = await runCli([]);
  assert.equal(usage.status, 64);
  assert.equal(usage.stdout, '');
  assert.equal(
    JSON.parse(usage.stderr).code,
    'QL3_CLUSTER_COPILOT_CLIENT_USAGE_INVALID',
  );

  const server = await startServer((request, response) => {
    request.resume();
    request.on('end', () => {
      jsonResponse(
        response,
        200,
        request.headers['x-request-id'],
        outputResponse(),
      );
    });
  });
  t.after(() => server.close());
  const directory = temporaryDirectory(t);
  const result = await runCli([
    `--config=${configuration(directory, server.port)}`,
    `--command=${commandFile(directory, 'output', 'output')}`,
    `--credential=${privateFile(directory, 'credential', credential)}`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const fact = JSON.parse(result.stdout);
  assert.equal(fact.operation, 'output');
  assert.equal(fact.result.result.text, 'diagnosis');
  assert.equal(fact.component, 'qinglong3-cluster-copilot-client');
});

test('rejects response framing drift, oversized bodies, aborts and timeouts', async (t) => {
  let mode = 'content-type';
  const server = await startServer((request, response) => {
    response.on('error', () => {});
    request.resume();
    request.on('end', () => {
      if (mode === 'timeout') return;
      if (mode === 'abort') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-request-id': request.headers['x-request-id'],
        });
        response.write('{"schema":');
        response.destroy();
        return;
      }
      if (mode === 'oversized') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-request-id': request.headers['x-request-id'],
        });
        response.end(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
        return;
      }
      const body = Buffer.from(JSON.stringify(diagnoseResponse()));
      response.writeHead(201, {
        'content-type': 'text/plain',
        'content-length': String(body.length),
        'x-request-id': request.headers['x-request-id'],
      });
      response.end(body);
    });
  });
  t.after(() => server.close());
  const directory = temporaryDirectory(t);
  const caFile = privateFile(directory, 'ca.pem', fs.readFileSync(caFixture));
  const configFile = privateFile(
    directory,
    'client.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
      endpoint: `https://localhost:${server.port}/`,
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 1_000,
    }),
  );
  const paths = {
    configFile,
    commandFile: commandFile(directory, 'diagnose', 'diagnose', {
      traceId: 'trace-1',
    }),
    credentialFile: privateFile(directory, 'credential', credential),
  };
  for (const failureMode of ['content-type', 'oversized', 'abort', 'timeout']) {
    mode = failureMode;
    await assert.rejects(executeClusterCopilotClient(paths), {
      code: 'QL3_CLUSTER_COPILOT_CLIENT_REQUEST_FAILED',
    });
  }
});
