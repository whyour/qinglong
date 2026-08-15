const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { InMemoryTransport } = require('@modelcontextprotocol/server');
const {
  CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
  ClusterCopilotClientRemoteError,
} = require('../dist/copilot-client/client.js');
const {
  CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
} = require('../dist/copilot-client/contracts.js');
const {
  CLUSTER_COPILOT_MCP_RESULT_SCHEMA,
  CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA,
  createQingLongClusterCopilotMcpServer,
  normalizeClusterCopilotMcpServerConfig,
  readClusterCopilotMcpServerConfig,
} = require('../dist/copilot-mcp/server.js');

const packageRoot = path.resolve(__dirname, '..');
const caFixture = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const credential = `ql3c_credential-1_${Buffer.alloc(32, 7).toString('base64url')}`;

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-copilot-mcp-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function privateFile(directory, name, contents) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  return fs.realpathSync(filePath);
}

function config(maxConcurrentRequests = 2) {
  return Object.freeze({
    schema: CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA,
    clientConfigFile: '/private/client.json',
    credentialFile: '/private/credential',
    maxConcurrentRequests,
  });
}

async function client(server, t) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  clientTransport.onmessage = (message) => {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  t.after(async () => {
    await clientTransport.close();
    await server.close();
  });
  let nextId = 1;
  const request = (method, params = undefined) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      clientTransport
        .send({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        })
        .catch(reject);
    });
  };
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'ql3-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  await clientTransport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  return { request };
}

test('discovers four exact bounded Tools and maps every call to a direct command', async (t) => {
  const executions = [];
  const server = createQingLongClusterCopilotMcpServer({
    config: config(),
    execute: async (execution) => {
      executions.push(execution);
      return Object.freeze({
        schemaVersion: 1,
        operation: execution.command.operation,
        requestId: execution.command.requestId,
        result: Object.freeze({ accepted: true }),
      });
    },
  });
  const connected = await client(server, t);
  const listed = await connected.request('tools/list', {});
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      'qinglong.cluster.copilot.failure_diagnose',
      'qinglong.cluster.copilot.failure_diagnosis.get',
      'qinglong.cluster.copilot.failure_diagnosis.output.get',
      'qinglong.cluster.copilot.failure_diagnosis.cancel',
    ],
  );
  assert.deepEqual(listed.result.tools.map((tool) => tool.annotations), [
    {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
  ]);
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.additionalProperties, false);
  }

  const base = {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'request-1',
  };
  const calls = [
    ['qinglong.cluster.copilot.failure_diagnose', { ...base, traceId: 'trace-1' }],
    ['qinglong.cluster.copilot.failure_diagnosis.get', base],
    ['qinglong.cluster.copilot.failure_diagnosis.output.get', base],
    ['qinglong.cluster.copilot.failure_diagnosis.cancel', { ...base, mutationId: 'mutation-1' }],
  ];
  const responses = [];
  for (const [name, argumentsValue] of calls) {
    responses.push(
      await connected.request('tools/call', { name, arguments: argumentsValue }),
    );
  }
  assert.deepEqual(
    executions.map((execution) => execution.command),
    [
      {
        schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
        operation: 'diagnose',
        ...base,
        traceId: 'trace-1',
      },
      { schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA, operation: 'inspect', ...base },
      { schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA, operation: 'output', ...base },
      {
        schema: CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
        operation: 'cancel',
        ...base,
        mutationId: 'mutation-1',
      },
    ],
  );
  assert.ok(executions.every((execution) => execution.configFile === '/private/client.json'));
  assert.ok(executions.every((execution) => execution.credentialFile === '/private/credential'));
  assert.deepEqual(
    responses.map((response) => response.result.structuredContent.sensitivity),
    ['low', 'low', 'potentially_sensitive', 'low'],
  );
  assert.deepEqual(responses[2].result.structuredContent, {
    schema: CLUSTER_COPILOT_MCP_RESULT_SCHEMA,
    operation: 'output',
    requestId: 'request-1',
    sensitivity: 'potentially_sensitive',
    trust: {
      classification: 'untrusted_model_output',
      instructionPolicy: 'data_only_never_execute',
      actionAuthority: 'none',
    },
    result: { accepted: true },
  });
});

test('fails closed on unknown input and returns only bounded remote error detail', async (t) => {
  let calls = 0;
  const server = createQingLongClusterCopilotMcpServer({
    config: config(),
    execute: async (execution) => {
      calls += 1;
      throw new ClusterCopilotClientRemoteError(
        429,
        'quota_exhausted',
        execution.command.requestId,
        12,
      );
    },
  });
  const connected = await client(server, t);
  const invalid = await connected.request('tools/call', {
    name: 'qinglong.cluster.copilot.failure_diagnosis.get',
    arguments: {
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'request-1',
      endpoint: 'https://forbidden.example/',
    },
  });
  assert.equal(calls, 0);
  assert.ok(invalid.error || invalid.result?.isError);
  assert.doesNotMatch(JSON.stringify(invalid), /forbidden\.example/);

  const rejected = await connected.request('tools/call', {
    name: 'qinglong.cluster.copilot.failure_diagnosis.get',
    arguments: {
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'request-1',
    },
  });
  assert.equal(calls, 1);
  assert.equal(rejected.result.isError, true);
  assert.deepEqual(JSON.parse(rejected.result.content[0].text), {
    code: 'copilot_remote_rejected',
    statusCode: 429,
    responseCode: 'quota_exhausted',
    requestId: 'request-1',
    retryAfterSeconds: 12,
  });
});

test('rejects shared-client result drift and unbounded remote error fields', async (t) => {
  const argumentsValue = {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    requestId: 'request-1',
  };
  const drifted = await client(
    createQingLongClusterCopilotMcpServer({
      config: config(),
      execute: async () => ({
        schemaVersion: 1,
        operation: 'output',
        requestId: 'request-1',
        result: {},
      }),
    }),
    t,
  );
  const driftedResponse = await drifted.request('tools/call', {
    name: 'qinglong.cluster.copilot.failure_diagnosis.get',
    arguments: argumentsValue,
  });
  assert.deepEqual(JSON.parse(driftedResponse.result.content[0].text), {
    code: 'copilot_request_failed',
  });

  const unbounded = await client(
    createQingLongClusterCopilotMcpServer({
      config: config(),
      execute: async () => {
        throw new ClusterCopilotClientRemoteError(
          999,
          'x'.repeat(1_000),
          'request-1',
          9_999,
        );
      },
    }),
    t,
  );
  const unboundedResponse = await unbounded.request('tools/call', {
    name: 'qinglong.cluster.copilot.failure_diagnosis.get',
    arguments: argumentsValue,
  });
  assert.deepEqual(JSON.parse(unboundedResponse.result.content[0].text), {
    code: 'copilot_request_failed',
  });
});

test('rejects concurrent work immediately without a hidden queue', async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const server = createQingLongClusterCopilotMcpServer({
    config: config(1),
    execute: async (execution) => {
      calls += 1;
      await held;
      return {
        schemaVersion: 1,
        operation: execution.command.operation,
        requestId: execution.command.requestId,
        result: {},
      };
    },
  });
  const connected = await client(server, t);
  const first = connected.request('tools/call', {
    name: 'qinglong.cluster.copilot.failure_diagnosis.get',
    arguments: {
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'request-1',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await connected.request('tools/call', {
    name: 'qinglong.cluster.copilot.failure_diagnosis.get',
    arguments: {
      projectId: 'project-1',
      sourceRunId: 'source-run-2',
      requestId: 'request-2',
    },
  });
  assert.equal(calls, 1);
  assert.equal(second.result.isError, true);
  assert.deepEqual(JSON.parse(second.result.content[0].text), {
    code: 'copilot_mcp_busy',
  });
  release();
  await first;
});

test('requires exact private startup configuration and validates client authority', (t) => {
  assert.throws(
    () =>
      normalizeClusterCopilotMcpServerConfig({
        ...config(),
        maxConcurrentRequests: 17,
      }),
    { code: 'QL3_CLUSTER_COPILOT_MCP_CONFIG_INVALID' },
  );
  const directory = temporaryDirectory(t);
  const caFile = privateFile(directory, 'ca.pem', fs.readFileSync(caFixture));
  const clientConfigFile = privateFile(
    directory,
    'client.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
      endpoint: 'https://localhost:9443/',
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 2_000,
    }),
  );
  const credentialFile = privateFile(directory, 'credential', credential);
  const serverConfigFile = privateFile(
    directory,
    'mcp.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA,
      clientConfigFile,
      credentialFile,
      maxConcurrentRequests: 2,
    }),
  );
  assert.deepEqual(readClusterCopilotMcpServerConfig(serverConfigFile), {
    schema: CLUSTER_COPILOT_MCP_SERVER_CONFIG_SCHEMA,
    clientConfigFile,
    credentialFile,
    maxConcurrentRequests: 2,
  });
  fs.chmodSync(serverConfigFile, 0o644);
  assert.throws(() => readClusterCopilotMcpServerConfig(serverConfigFile), {
    code: 'QL3_CLUSTER_COPILOT_MCP_CONFIG_INVALID',
  });
});
