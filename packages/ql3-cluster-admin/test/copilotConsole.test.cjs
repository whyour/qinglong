const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createServer, request: httpRequest } = require('node:http');
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
  clusterCopilotConsoleProjectReadPath,
  normalizeClusterCopilotConsoleReadRequest,
} = require('../dist/copilot-console/contracts.js');
const {
  ClusterCopilotConsoleConfigurationError,
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
      schema:
        'qinglong/cluster-copilot-failure-diagnosis-inspection-response@v1',
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
      schema:
        'qinglong/cluster-copilot-failure-diagnosis-output-read-response@v1',
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

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.notEqual(typeof address, 'string');
  assert.notEqual(address, null);
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('normalizes Copilot and fixed Project observation operations without arbitrary paths', () => {
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
  const runList = normalizeClusterCopilotConsoleReadRequest({
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: 'run_list',
    projectId: 'project-main',
    requestId: 'console-read-1',
    afterCreatedAtMs: 1_700_000_000_000,
    afterRunId: 'run-9',
    limit: 32,
  });
  assert.equal(
    clusterCopilotConsoleProjectReadPath(runList),
    '/api/v3/projects/project-main/runs?after_created_at_ms=1700000000000&after_run_id=run-9&limit=32',
  );
  assert.throws(() => clusterCopilotConsoleClientCommand(runList), {
    code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID',
  });
  assert.throws(
    () =>
      normalizeClusterCopilotConsoleReadRequest({
        ...target(),
        operation: 'diagnose',
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
  assert.deepEqual(
    normalizeClusterCopilotConsoleReadRequest({
      schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
      operation: 'run_cancellation_status',
      projectId: 'project-main',
      requestId: 'console-read-status',
    }),
    {
      schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
      operation: 'run_cancellation_status',
      projectId: 'project-main',
      requestId: 'console-read-status',
    },
  );
  assert.throws(
    () =>
      clusterCopilotConsoleProjectReadPath({
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'run_cancellation_status',
        projectId: 'project-main',
        requestId: 'console-read-status',
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
  const workerList = normalizeClusterCopilotConsoleReadRequest({
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: 'worker_list',
    projectId: 'project-main',
    requestId: 'console-worker-list',
    afterWorkerId: 'worker-16',
  });
  assert.deepEqual(workerList, {
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: 'worker_list',
    projectId: 'project-main',
    requestId: 'console-worker-list',
    afterWorkerId: 'worker-16',
  });
  assert.throws(() => clusterCopilotConsoleProjectReadPath(workerList), {
    code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID',
  });
  const packageList = normalizeClusterCopilotConsoleReadRequest({
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: 'package_list',
    projectId: 'project-main',
    requestId: 'console-package-list',
    afterPackageName: 'ops-package',
  });
  assert.deepEqual(packageList, {
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: 'package_list',
    projectId: 'project-main',
    requestId: 'console-package-list',
    afterPackageName: 'ops-package',
  });
  assert.throws(() => clusterCopilotConsoleProjectReadPath(packageList), {
    code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID',
  });
  assert.throws(
    () =>
      normalizeClusterCopilotConsoleReadRequest({
        ...target(),
        mutationId: 'forbidden',
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
});

test('maps every reviewed Project observation operation to one fixed GET path', () => {
  const workflowRunId = '123e4567-e89b-42d3-a456-426614174000';
  const workflowStepRunId = '123e4567-e89b-42d3-a456-426614174001';
  const cases = [
    [
      {
        operation: 'run_list',
        afterCreatedAtMs: 1_700_000_000_000,
        afterRunId: 'run-9',
        limit: 32,
      },
      '/api/v3/projects/project-main/runs?after_created_at_ms=1700000000000&after_run_id=run-9&limit=32',
    ],
    [
      { operation: 'run_read', runId: 'run-9' },
      '/api/v3/projects/project-main/runs/run-9',
    ],
    [
      {
        operation: 'run_event_list',
        runId: 'run-9',
        afterSequence: 7,
        limit: 16,
      },
      '/api/v3/projects/project-main/runs/run-9/events?after_sequence=7&limit=16',
    ],
    [
      {
        operation: 'run_step_list',
        runId: 'run-9',
        afterStepKey: 'model',
        afterStepRunId: 'step-run-3',
        limit: 8,
      },
      '/api/v3/projects/project-main/runs/run-9/steps?after_step_key=model&after_step_run_id=step-run-3&limit=8',
    ],
    [
      { operation: 'task_list', afterTaskId: 'task-9', limit: 4 },
      '/api/v3/projects/project-main/tasks?after_task_id=task-9&limit=4',
    ],
    [
      { operation: 'task_read', taskId: 'task-9' },
      '/api/v3/projects/project-main/tasks/task-9',
    ],
    [
      { operation: 'workflow_list', packageName: 'ops-pack' },
      '/api/v3/projects/project-main/packages/ops-pack/workflows',
    ],
    [
      {
        operation: 'workflow_run_list',
        packageName: 'ops-pack',
        workflowId: 'nightly-repair',
        afterAdmittedAtMs: 1_700_000_000_000,
        afterRunId: workflowRunId,
        limit: 32,
      },
      '/api/v3/projects/project-main/packages/ops-pack/workflows/nightly-repair/runs?after_admitted_at_ms=1700000000000&after_run_id=123e4567-e89b-42d3-a456-426614174000&limit=32',
    ],
    [
      {
        operation: 'workflow_run_read',
        packageName: 'ops-pack',
        workflowId: 'nightly-repair',
        runId: workflowRunId,
      },
      '/api/v3/projects/project-main/packages/ops-pack/workflows/nightly-repair/runs/123e4567-e89b-42d3-a456-426614174000',
    ],
    [
      {
        operation: 'workflow_event_list',
        packageName: 'ops-pack',
        workflowId: 'nightly-repair',
        runId: workflowRunId,
        afterSequence: 9,
        limit: 16,
      },
      '/api/v3/projects/project-main/packages/ops-pack/workflows/nightly-repair/runs/123e4567-e89b-42d3-a456-426614174000/events?after_sequence=9&limit=16',
    ],
    [
      {
        operation: 'workflow_step_list',
        packageName: 'ops-pack',
        workflowId: 'nightly-repair',
        runId: workflowRunId,
        afterStepKey: 'publish',
        afterStepRunId: workflowStepRunId,
        limit: 8,
      },
      '/api/v3/projects/project-main/packages/ops-pack/workflows/nightly-repair/runs/123e4567-e89b-42d3-a456-426614174000/steps?after_step_key=publish&after_step_run_id=123e4567-e89b-42d3-a456-426614174001&limit=8',
    ],
  ];

  for (const [requestFields, expectedPath] of cases) {
    const normalized = normalizeClusterCopilotConsoleReadRequest({
      schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
      projectId: 'project-main',
      requestId: 'console-read-1',
      ...requestFields,
    });
    assert.equal(
      clusterCopilotConsoleProjectReadPath(normalized),
      expectedPath,
    );
    assert.equal(Object.isFrozen(normalized), true);
  }

  assert.throws(
    () =>
      normalizeClusterCopilotConsoleReadRequest({
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'run_step_list',
        projectId: 'project-main',
        requestId: 'console-read-1',
        runId: 'run-9',
        afterStepKey: 'model',
        afterStepRunId: null,
        limit: 8,
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
  assert.throws(
    () =>
      normalizeClusterCopilotConsoleReadRequest({
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'workflow_run_read',
        projectId: 'project-main',
        requestId: 'console-read-1',
        packageName: 'ops-pack',
        workflowId: 'nightly-repair',
        runId: 'not-a-workflow-run-uuid',
      }),
    { code: 'QL3_CLUSTER_COPILOT_CONSOLE_READ_REQUEST_INVALID' },
  );
});

test('loads only digest-bound packaged assets and rejects drift', async (t) => {
  const assets = loadClusterCopilotConsoleAssets(moduleDirectory);
  assert.match(assets.html, /沿着证据读，不替集群做决定/);
  assert.match(assets.css, /prefers-reduced-motion/);
  assert.match(
    assets.evidenceBundle,
    /qinglong\/cluster-console-redacted-evidence-bundle@v1/,
  );
  assert.match(assets.evidenceBundle, /createClusterConsoleEvidenceBundle/);
  assert.match(assets.javascript, /output\.textContent = JSON\.stringify/);
  assert.match(assets.javascript, /run_event_list/);
  assert.match(assets.javascript, /createClusterConsoleEvidenceBundle/);
  assert.doesNotMatch(
    assets.javascript,
    /localStorage|sessionStorage|innerHTML/,
  );

  const root = await mkdtemp(join(tmpdir(), 'ql3-console-assets-'));
  t.after(() =>
    require('node:fs').rmSync(root, { recursive: true, force: true }),
  );
  const fakeModuleDirectory = join(root, 'dist', 'copilot-console');
  await mkdir(fakeModuleDirectory, { recursive: true });
  await cp(resolve(moduleDirectory, '../../assets'), join(root, 'assets'), {
    recursive: true,
  });
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
  assert.match(html.text, /Cluster field ledger/);

  const css = await request(server.origin, { path: '/app.css' });
  const evidenceBundle = await request(server.origin, {
    path: '/evidence-bundle.js',
  });
  const javascript = await request(server.origin, { path: '/app.js' });
  assert.equal(css.statusCode, 200);
  assert.equal(evidenceBundle.statusCode, 200);
  assert.equal(javascript.statusCode, 200);
  assert.equal(
    evidenceBundle.headers['content-type'],
    'text/javascript; charset=utf-8',
  );
  assert.match(
    evidenceBundle.text,
    /qinglong\/cluster-console-redacted-evidence-bundle@v1/,
  );
  assert.equal(
    javascript.headers['content-type'],
    'text/javascript; charset=utf-8',
  );
});

test('allows only an explicit fixed-port container listener behind host loopback publication', async (t) => {
  const token = randomBytes(32).toString('base64url');
  await assert.rejects(
    startClusterCopilotConsoleServer({
      assets: loadClusterCopilotConsoleAssets(moduleDirectory),
      executor: { execute: async () => inspection() },
      networkBoundary: 'container-published-loopback',
      port: 0,
      sessionDigest: clusterCopilotConsoleSessionDigest(token),
    }),
    ClusterCopilotConsoleConfigurationError,
  );
  const server = await startClusterCopilotConsoleServer({
    assets: loadClusterCopilotConsoleAssets(moduleDirectory),
    executor: { execute: async () => inspection() },
    networkBoundary: 'container-published-loopback',
    port: await unusedPort(),
    sessionDigest: clusterCopilotConsoleSessionDigest(token),
  });
  t.after(() => server.close());
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.equal((await request(server.origin)).statusCode, 200);
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
      schema: 'qinglong/cluster-copilot-console-read-request@v1',
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

test('forwards one exact bounded Run list read and exposes no path field', async (t) => {
  const requests = [];
  const { server, headers } = await fixture(async (read) => {
    requests.push(read);
    return {
      schemaVersion: 1,
      requestId: read.requestId,
      result: { runs: [], hasMore: false },
    };
  });
  t.after(() => server.close());
  const body = {
    schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
    operation: 'run_list',
    projectId: 'project-main',
    requestId: 'console-read-2',
    afterCreatedAtMs: null,
    afterRunId: null,
    limit: 32,
  };
  const response = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/observe/run-list',
    headers,
    body,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(requests, [body]);
  assert.deepEqual(response.body.result.result, { runs: [], hasMore: false });
  assert.equal(Object.hasOwn(requests[0], 'path'), false);
  assert.equal(Object.hasOwn(requests[0], 'url'), false);
});

test('routes only the three fixed Run management reads and validates their cursors', async (t) => {
  const reads = [];
  const { server, headers } = await fixture(async (read) => {
    reads.push(read);
    return {
      schemaVersion: 1,
      requestId: read.requestId,
      result: { operation: read.operation },
    };
  });
  t.after(() => server.close());
  const cases = [
    [
      '/api/v1/run-management/cancellation-status',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'run_cancellation_status',
        projectId: 'project-main',
        requestId: 'console-status-1',
      },
    ],
    [
      '/api/v1/run-management/blocked-cancellations',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'run_cancellation_blocked_list',
        projectId: 'project-main',
        requestId: 'console-blocked-1',
        cursor: null,
      },
    ],
    [
      '/api/v1/run-management/cancellation-inspect',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'run_cancellation_inspect',
        projectId: 'project-main',
        requestId: 'console-inspect-1',
        runId: 'run-1',
      },
    ],
  ];
  for (const [path, body] of cases) {
    const response = await request(server.origin, {
      method: 'POST',
      path,
      headers,
      body,
    });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(
    reads,
    cases.map(([, body]) => body),
  );

  const invalidCursor = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/run-management/blocked-cancellations',
    headers,
    body: { ...cases[1][1], cursor: 'opaque-unversioned' },
  });
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(reads.length, 3);
});

test('routes only fixed Worker list and inspect reads with a bounded cursor', async (t) => {
  const reads = [];
  const { server, headers } = await fixture(async (read) => {
    reads.push(read);
    return {
      schemaVersion: 1,
      requestId: read.requestId,
      result: { operation: read.operation },
    };
  });
  t.after(() => server.close());
  const cases = [
    [
      '/api/v1/worker-management/workers',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'worker_list',
        projectId: 'project-main',
        requestId: 'console-worker-list-1',
        afterWorkerId: null,
      },
    ],
    [
      '/api/v1/worker-management/worker',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'worker_inspect',
        projectId: 'project-main',
        requestId: 'console-worker-inspect-1',
        workerId: 'worker-a',
      },
    ],
  ];
  for (const [path, body] of cases) {
    const response = await request(server.origin, {
      method: 'POST',
      path,
      headers,
      body,
    });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(
    reads,
    cases.map(([, body]) => body),
  );
  const invalidCursor = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/worker-management/workers',
    headers,
    body: { ...cases[0][1], afterWorkerId: 'contains space' },
  });
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(reads.length, 2);
});

test('routes only fixed Package installation list and inspect reads', async (t) => {
  const reads = [];
  const { server, headers } = await fixture(async (read) => {
    reads.push(read);
    return {
      schemaVersion: 1,
      requestId: read.requestId,
      result: { operation: read.operation },
    };
  });
  t.after(() => server.close());
  const cases = [
    [
      '/api/v1/package-management/installations',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'package_list',
        projectId: 'project-main',
        requestId: 'console-package-list-1',
        afterPackageName: null,
      },
    ],
    [
      '/api/v1/package-management/installation',
      {
        schema: CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA,
        operation: 'package_inspect',
        projectId: 'project-main',
        requestId: 'console-package-inspect-1',
        packageName: 'ops-package',
      },
    ],
  ];
  for (const [path, body] of cases) {
    const response = await request(server.origin, {
      method: 'POST',
      path,
      headers,
      body,
    });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(
    reads,
    cases.map(([, body]) => body),
  );
  const invalidCursor = await request(server.origin, {
    method: 'POST',
    path: '/api/v1/package-management/installations',
    headers,
    body: { ...cases[0][1], afterPackageName: 'Contains_underscore' },
  });
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(reads.length, 2);
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
  assert.equal(
    response.headers['content-type'],
    'application/json; charset=utf-8',
  );
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
    {
      ...headers,
      authorization: 'QL3-Console ' + randomBytes(32).toString('base64url'),
    },
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
