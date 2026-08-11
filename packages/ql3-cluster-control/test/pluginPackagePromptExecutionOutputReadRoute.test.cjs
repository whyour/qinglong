const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createClusterControlPluginPackagePromptExecutionOutputReadRoute,
} = require('@qinglong/cluster-control/prompt-routes');

const parameters = Object.freeze({
  projectId: 'project-1',
  packageName: 'example',
  promptId: 'summary',
  executionRequestId: 'execution-request-1',
});

function authorized(body = null) {
  return {
    request: {
      requestId: 'request-1',
      method: 'GET',
      path: '/unused',
      query: {},
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'user', id: 'owner-1' },
      authenticationId: 'authentication-1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'multi_factor',
    },
    operationId: 'prompt.execution.output.read',
    permission: 'artifact.read',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
  };
}

function available(command, overrides = {}) {
  return {
    schema: 'qinglong/plugin-package-prompt-execution-output-read-result@v1',
    status: 'available',
    projectId: command.projectId,
    packageName: command.packageName,
    promptId: command.promptId,
    executionRequestId: command.executionRequestId,
    reference: {
      schema: 'qinglong/plugin-package-prompt-output-artifact-reference@v1',
      artifactId: 'pao:0123456789abcdef0123456789abcdef',
      projectId: command.projectId,
      runId: '00000000-0000-4000-8000-000000000010',
      stepRunId: 'step-1',
      invocationId: 'invocation-1',
      contentDigest: 'b'.repeat(64),
      outputBytes: 14,
      retentionPolicyDigest: 'c'.repeat(64),
      retentionEligibleAtMs: 10_000,
      keyId: 'key-1',
      algorithm: 'aes-256-gcm',
      artifactDigest: 'a'.repeat(64),
    },
    result: {
      provider: 'provider-1',
      model: 'model-1',
      text: 'private output',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    ...overrides,
  };
}

test('reads durable Prompt output by caller-known execution requestId', async () => {
  let command;
  const route = createClusterControlPluginPackagePromptExecutionOutputReadRoute({
    async read(value) {
      command = value;
      return available(value);
    },
  });
  assert.equal(route.operationId, 'prompt.execution.output.read');
  assert.equal(route.permission, 'artifact.read');
  const result = await route.handle(authorized(), parameters);
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.body.schema,
    'qinglong/cluster-plugin-package-prompt-execution-output-read-response@v1',
  );
  assert.equal(result.body.result.text, 'private output');
  assert.equal(command.executionRequestId, parameters.executionRequestId);
  assert.equal(command.principal.subject.id, 'owner-1');
});

test('masks missing output and rejects malformed requests before capability', async () => {
  let calls = 0;
  const route = createClusterControlPluginPackagePromptExecutionOutputReadRoute({
    async read(command) {
      calls += 1;
      return {
        schema: 'qinglong/plugin-package-prompt-execution-output-read-result@v1',
        status: 'not_found',
        projectId: command.projectId,
        packageName: command.packageName,
        promptId: command.promptId,
        executionRequestId: command.executionRequestId,
      };
    },
  });
  assert.deepEqual(await route.handle(authorized(), parameters), {
    statusCode: 404,
    body: { code: 'prompt_execution_output_not_found' },
  });
  assert.equal(calls, 1);
  assert.equal(
    (await route.handle(authorized({ widened: true }), parameters)).statusCode,
    400,
  );
  assert.equal(calls, 1);
});

test('fails closed when capability widens or drifts from the exact target', async () => {
  const route = createClusterControlPluginPackagePromptExecutionOutputReadRoute({
    async read(command) {
      return available(command, { packageName: 'another-package' });
    },
  });
  assert.deepEqual(await route.handle(authorized(), parameters), {
    statusCode: 503,
    body: { code: 'prompt_execution_output_read_unavailable' },
  });
});
