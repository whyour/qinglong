const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_REQUEST_SCHEMA,
  CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_RESPONSE_SCHEMA,
  createClusterControlPluginPackagePromptExecutionRoute,
} = require('@qinglong/cluster-control/prompt-routes');

function authorized(body, overrides = {}) {
  return {
    request: {
      requestId: '00000000-0000-4000-8000-000000000001',
      method: 'POST',
      path: '/api/v3/projects/project-1/packages/example/prompts/summary/executions',
      query: {},
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'api_app', id: 'app-1' },
      authenticationId: 'credential-1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'service',
    },
    operationId: 'prompt.execute',
    permission: 'model.invoke',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    schema: CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_REQUEST_SCHEMA,
    requestId: 'prompt-request-1',
    traceId: 'trace-1',
    parameters: { subject: 'private input' },
    provider: 'openai-compatible',
    model: 'model-a',
    maxOutputTokens: 512,
    temperature: 0.2,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function result(status = 'executed', liveResult = { text: 'private output' }) {
  return {
    status,
    admission: {
      requestId: 'prompt-request-1',
      invocationId: 'ppi:1',
      runId: 'ppr:1',
      stepRunId: 'pps:1',
    },
    finalization: { runStatus: 'succeeded' },
    result: liveResult,
  };
}

test('builds a bounded subject- and policy-fenced execution command', async () => {
  let command;
  const route = createClusterControlPluginPackagePromptExecutionRoute(
    {
      async execute(value) {
        command = value;
        return result();
      },
    },
    {
      now: () => 2_000,
      maxExecutionMs: 10_000,
      createEventId: () => '00000000-0000-4000-8000-000000000002',
    },
  );
  const request = authorized(body());
  const response = await route.handle(request, {
    projectId: 'project-1',
    packageName: 'example',
    promptId: 'summary',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.schema, CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_RESPONSE_SCHEMA);
  assert.equal(response.body.replayed, false);
  assert.equal(response.body.result.text, 'private output');
  assert.deepEqual(command.principal, request.principal);
  assert.equal(command.auditEventId, '00000000-0000-4000-8000-000000000002');
  assert.deepEqual(command.policyFence, { projectVersion: 3, bindingVersion: 7 });
  assert.equal(command.plannedAtMs, 2_000);
  assert.equal(command.deadlineAtMs, 7_000);
  assert.equal(command.signal, request.request.signal);
  assert.equal('publication' in command, false);
  assert.equal('publicationDigest' in command, false);
});

test('returns an explicit content-free replay receipt', async () => {
  const route = createClusterControlPluginPackagePromptExecutionRoute({
    async execute() {
      return result('existing', null);
    },
  });
  const response = await route.handle(authorized(body()), {
    projectId: 'project-1',
    packageName: 'example',
    promptId: 'summary',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.replayed, true);
  assert.equal(response.body.result, null);
});

test('strictly carries durable output intent and returns only its reference on replay', async () => {
  let command;
  const outputArtifact = {
    schema: 'qinglong/plugin-package-prompt-output-artifact-reference@v1',
    artifactId: 'pao:artifact-1',
    artifactDigest: 'b'.repeat(64),
  };
  const route = createClusterControlPluginPackagePromptExecutionRoute({
    async execute(value) {
      command = value;
      return { ...result('existing', null), outputArtifact };
    },
  });
  const output = {
    mode: 'durable_artifact',
    retentionPolicy: {
      revision: 'cluster-prompt-output-v1',
      retentionMs: 86_400_000,
    },
  };
  const response = await route.handle(authorized(body({ output })), {
    projectId: 'project-1',
    packageName: 'example',
    promptId: 'summary',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(command.output, output);
  assert.equal(response.body.result, null);
  assert.deepEqual(response.body.outputArtifact, outputArtifact);
});

test('rejects malformed or over-timeout bodies before the capability', async () => {
  let calls = 0;
  const route = createClusterControlPluginPackagePromptExecutionRoute(
    { async execute() { calls += 1; return result(); } },
    { maxExecutionMs: 1_000 },
  );
  for (const invalid of [
    body({ timeoutMs: 1_001 }),
    body({ publication: {} }),
    body({ publicationDigest: 'a'.repeat(64) }),
    body({ parameters: { bad: 7 } }),
    body({ output: { mode: 'durable_artifact', retentionPolicy: {
      revision: 'cluster-prompt-output-v1', retentionMs: 1,
    } } }),
    body({ output: { mode: 'live_only', unexpected: true } }),
  ]) {
    const response = await route.handle(authorized(invalid), {
      projectId: 'project-1',
      packageName: 'example',
      promptId: 'summary',
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { code: 'invalid_prompt_execution_request' });
  }
  assert.equal(calls, 0);
});

test('maps internal errors to low-sensitive stable transport codes', async () => {
  for (const [internal, statusCode, external] of [
    ['PLUGIN_PACKAGE_PROMPT_ADMISSION_NOT_ALLOWED', 409, 'prompt_execution_conflict'],
    ['MODEL_GATEWAY_BUSY', 429, 'prompt_execution_capacity_exceeded'],
    ['MODEL_POLICY_DENIED', 422, 'prompt_execution_policy_rejected'],
    ['MODEL_INVOCATION_DEADLINE_EXCEEDED', 504, 'prompt_execution_deadline_exceeded'],
    ['MODEL_PROVIDER_UNAVAILABLE', 503, 'prompt_execution_unavailable'],
  ]) {
    const route = createClusterControlPluginPackagePromptExecutionRoute({
      async execute() {
        throw Object.assign(new Error('private provider detail'), { code: internal });
      },
    });
    const response = await route.handle(authorized(body()), {
      projectId: 'project-1',
      packageName: 'example',
      promptId: 'summary',
    });
    assert.equal(response.statusCode, statusCode, internal);
    assert.deepEqual(response.body, { code: external });
    assert.equal(JSON.stringify(response).includes('private provider detail'), false);
  }
});
