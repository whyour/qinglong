const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { request: httpRequest } = require('node:http');
const { mkdtemp, mkdir, cp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const {
  ClusterCopilotClientRemoteError,
} = require('../dist/copilot-client/client.js');
const {
  ClusterCopilotConsoleAssetError,
  loadClusterCopilotConsoleAssets,
} = require('../dist/copilot-console/assets.js');
const {
  CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
  clusterCopilotConsoleClientCommand,
  normalizeClusterCopilotConsoleReadRequest,
} = require('../dist/copilot-console/contracts.js');
const {
  clusterCopilotConsoleSessionDigest,
  startClusterCopilotConsoleServer,
} = require('../dist/copilot-console/server.js');

const moduleDirectory = resolve(__dirname, '../dist/copilot-console');

function target(operation = 'inspect') {
  return {
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation,
    projectId: 'project-main',
    sourceRunId: 'run-source-1',
    requestId: 'diagnosis-request-1',
  };
}

function inspection() {
  return {
    schemaVersion: 1,
    operation: 'inspect',
    requestId: 'transport-read-1',
    result: {
      schema: 'qinglong/cluster-copilot-failure-diagnosis-inspection-response@v1',
      status: 'terminal',
      projectId: 'project-main',
      sourceRunId: 'run-source-1',
      requestId: 'diagnosis-request-1',
      diagnosisRunId: 'run-diagnosis-1',
      outcome: 'succeeded',
      stage: 'model',
      reason: null,
      outputAvailable: true,
      admittedAtMs: 1_700_000_000_000,
      finalizedAtMs: 1_700_000_001_000,
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        currency: 'USD',
        costMicros: 42,
      },
    },
  };
}

function output() {
  const text = '<script>never execute</script>';
  return {
    schemaVersion: 1,
    operation: 'output',
    requestId: 'transport-read-2',
    result: {
      schema: 'qinglong/cluster-copilot-failure-diagnosis-output-read-response@v1',
      status: 'available',
      projectId: 'project-main',
      sourceRunId: 'run-source-1',
      requestId: 'diagnosis-request-1',
      diagnosisRunId: 'run-diagnosis-1',
      reference: {
        artifactId: 'artifact-diagnosis-1',
        artifactDigest: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        outputBytes: Buffer.byteLength(text),
        sealedAtMs: 1_700_000_001_000,
      },
      result: {
        text,
        finishReason: 'stop',
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          costMicros: 42,
        },
      },
    },
  };
}

function request(origin, options = {}) {
  const url = new URL(origin);
  const body =
    options.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(options.body), 'utf8');
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        method: options.method || 'GET',
        path: options.path || '/',
        agent: false,
        headers: {
          ...(options.headers || {}),
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(body.length),
              }),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const text = bytes.toString('utf8');
          resolve({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            text,
            body:
              incoming.headers['content-type'] ===
              'application/json; charset=utf-8'
                ? JSON.parse(text)
                : null,
          });
        });
      },
    );
    outgoing.once('error', reject);
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

async function fixture(execute = async () => inspection()) {
  const token = randomBytes(32).toString('base64url');
  const server = await startClusterCopilotConsoleServer({
    assets: loadClusterCopilotConsoleAssets(moduleDirectory),
    executor: { execute },
    port: 0,
    sessionDigest: clusterCopilotConsoleSessionDigest(token),
  });
  return {
    token,
    server,
    headers: {
      authorization: 'QL3-Console ' + token,
      origin: server.origin,
    },
  };
}

test('normalizes only the two read operations into the shared client contract', () => {
  assert.deepEqual(
    clusterCopilotConsoleClientCommand(
      normalizeClusterCopilotConsoleReadRequest(target('inspect')),
    ),
    {
      schema: 'qinglong/cluster-copilot-client-command@v1',
      operation: 'inspect',
      projectId: 'project-main',
      sourceRunId: 'run-source-1',
      requestId: 'diagnosis-request-1',
    },
  );
  assert.equal(
    clusterCopilotConsoleClientCommand(target('output')).operation,
    'output',
  );
  assert.throws(
    () =>
      normalizeClusterCopilotConsoleReadRequest({
        ...target(),
        operation: 'diagnose',
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
  assert.throws(
    () =>
      normalizeClusterCopilotConsoleReadRequest({
        ...target(),
        mutationId: 'forbidden',
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
});

test('loads only digest-bound packaged assets and rejects drift', async (t) => {
  const assets = loadClusterCopilotConsoleAssets(moduleDirectory);
  assert.match(assets.html, /故障诊断，不替你执行/);
  assert.match(assets.css, /prefers-reduced-motion/);
  assert.match(assets.javascript, /textContent = fact\.result\.text/);
  assert.doesNotMatch(assets.javascript, /localStorage|sessionStorage|innerHTML/);

  const root = await mkdtemp(join(tmpdir(), 'ql3-console-assets-'));
  t.after(() => require('node:fs').rmSync(root, { recursive: true, force: true }));
  const fakeModuleDirectory = join(root, 'dist', 'copilot-console');
  await mkdir(fakeModuleDirectory, { recursive: true });
  await cp(
    resolve(moduleDirectory, '../../assets'),
    join(root, 'assets'),
    { recursive: true },
  );
  await writeFile(
    join(root, 'assets', 'copilot-console', 'app.js'),
    '"drift";\n',
  );
  assert.throws(
    () => loadClusterCopilotConsoleAssets(fakeModuleDirectory),
    ClusterCopilotConsoleAssetError,
  );
});

test('serves an immutable same-origin shell with a closed browser policy', async (t) => {
  const { server } = await fixture();
  t.after(() => server.close());
  const html = await request(server.origin);
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.equal(html.headers['x-frame-options'], 'DENY');
  assert.match(html.headers['content-security-policy'], /default-src 'none'/);
  assert.match(html.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(html.text, /Cluster field console/);

  const css = await request(server.origin, { path: '/app.css' });
  const javascript = await request(server.origin, { path: '/app.js' });
  assert.equal(css.statusCode, 200);
  assert.equal(javascript.statusCode, 200);
  assert.equal(javascript.headers['content-type'], 'text/javascript; charset=utf-8');
});

test('keeps the Cluster credential server-side and forwards one exact inspect', async (t) => {
  const commands = [];
  const { server, headers } = await fixture(async (command) => {
    commands.push(command);
    return inspection();
  });
  t.after(() => server.close());
  const response = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/copilot/inspect',
    headers,
    body: target('inspect'),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(commands, [
    {
      schema: 'qinglong/cluster-copilot-client-command@v1',
      operation: 'inspect',
      projectId: 'project-main',
      sourceRunId: 'run-source-1',
      requestId: 'diagnosis-request-1',
    },
  ]);
  assert.equal(
    response.body.schema,
    'qinglong/cluster-copilot-console-read-response@v1',
  );
  assert.equal(response.body.result.result.outputAvailable, true);
  assert.doesNotMatch(response.text, /ql3c_|authorization|credential/i);
});

test('returns model text as JSON data only after an explicit output read', async (t) => {
  const { server, headers } = await fixture(async (command) => {
    assert.equal(command.operation, 'output');
    return output();
  });
  t.after(() => server.close());
  const response = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/copilot/output',
    headers,
    body: target('output'),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.result.result.result.text,
    '<script>never execute</script>',
  );
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('masks wrong Host, Origin, session and every non-read route', async (t) => {
  let calls = 0;
  const { server, token, headers } = await fixture(async () => {
    calls += 1;
    return inspection();
  });
  t.after(() => server.close());
  const cases = [
    { ...headers, origin: 'https://attacker.example' },
    { ...headers, authorization: 'QL3-Console ' + randomBytes(32).toString('base64url') },
    { ...headers, host: 'attacker.example' },
  ];
  for (const candidate of cases) {
    const response = await request(server.origin, {
      method: 'POST',
      path: '/api/v1/copilot/inspect',
      headers: candidate,
      body: target(),
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { code: 'not_found' });
  }
  const mutation = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/copilot/diagnose',
    headers: {
      authorization: 'QL3-Console ' + token,
      origin: server.origin,
    },
    body: target(),
  });
  assert.equal(mutation.statusCode, 404);
  assert.equal(calls, 0);
});

test('rejects widened and route-confused read bodies before upstream authority', async (t) => {
  let calls = 0;
  const { server, headers } = await fixture(async () => {
    calls += 1;
    return inspection();
  });
  t.after(() => server.close());
  const widened = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/copilot/inspect',
    headers,
    body: { ...target(), endpoint: 'https://attacker.example' },
  });
  const confused = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/copilot/output',
    headers,
    body: target('inspect'),
  });
  assert.equal(widened.statusCode, 400);
  assert.equal(confused.statusCode, 400);
  assert.equal(calls, 0);
});

test('rejects a third concurrent read without a hidden queue', async (t) => {
  const releases = [];
  const { server, headers } = await fixture(
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve(inspection()));
      }),
  );
  t.after(() => server.close());
  const options = {
    method: 'POST',
    path: '/api/v1/copilot/inspect',
    headers,
    body: target(),
  };
  const first = request(server.origin, options);
  const second = request(server.origin, options);
  while (releases.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const third = await request(server.origin, options);
  assert.equal(third.statusCode, 429);
  assert.equal(third.body.code, 'cluster_copilot_console_busy');
  assert.equal(releases.length, 2);
  releases.splice(0).forEach((release) => release());
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
});

test('projects only bounded remote failure facts and closes idempotently', async () => {
  const { server, headers } = await fixture(async () => {
    throw new ClusterCopilotClientRemoteError(
      429,
      'project_read_rate_limited',
      'transport-read-3',
      7,
    );
  });
  const response = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/copilot/inspect',
    headers,
    body: target(),
  });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, {
    schema: 'qinglong/cluster-copilot-console-read-response@v1',
    code: 'project_read_rate_limited',
    requestId: 'transport-read-3',
    retryAfterSeconds: 7,
  });
  assert.equal(response.headers['retry-after'], '7');
  await server.close();
  await server.close();
});
