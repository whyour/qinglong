const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createClusterControlPluginPackagePromptOutputReadRoute,
} = require('@qinglong/cluster-control/prompt-routes');

const DIGEST = 'a'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);
const RETENTION_DIGEST = 'c'.repeat(64);
const ARTIFACT_ID = 'pao:1234';

function authorized(query = { artifact_digest: [DIGEST] }, body = null) {
  return {
    request: {
      requestId: 'request-1',
      method: 'GET',
      path: '/unused',
      query,
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'user', id: 'user-1' },
      authenticationId: 'auth-1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'multi_factor',
    },
    operationId: 'prompt.output.read',
    permission: 'artifact.read',
    projectId: 'project-1',
    policyFence: { projectVersion: 1, bindingVersion: 1 },
  };
}

function available(command, overrides = {}) {
  return {
    schema: 'qinglong/plugin-package-prompt-output-read-result@v1',
    status: 'available',
    reference: {
      schema: 'qinglong/plugin-package-prompt-output-artifact-reference@v1',
      artifactId: command.artifactId,
      projectId: command.projectId,
      runId: command.runId,
      stepRunId: 'step-1',
      invocationId: 'invocation-1',
      contentDigest: CONTENT_DIGEST,
      outputBytes: 14,
      retentionPolicyDigest: RETENTION_DIGEST,
      retentionEligibleAtMs: 10_000,
      keyId: 'key-1',
      algorithm: 'aes-256-gcm',
      artifactDigest: command.artifactDigest,
    },
    result: {
      provider: 'openai-compatible',
      model: 'model-1',
      text: 'durable output',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    ...overrides,
  };
}

test('returns one bounded Prompt output after the reviewed read capability', async () => {
  let command;
  const route = createClusterControlPluginPackagePromptOutputReadRoute({
    async read(value) {
      command = value;
      return available(value);
    },
  });
  const result = await route.handle(authorized(), {
    projectId: 'project-1',
    runId: 'run-1',
    artifactId: ARTIFACT_ID,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.schema,
    'qinglong/cluster-plugin-package-prompt-output-read-response@v1');
  assert.equal(result.body.result.text, 'durable output');
  assert.equal(command.principal.subject.id, 'user-1');
  assert.equal(command.artifactDigest, DIGEST);
});

test('masks product not-found and rejects malformed requests before capability', async () => {
  let calls = 0;
  const route = createClusterControlPluginPackagePromptOutputReadRoute({
    async read() {
      calls += 1;
      return {
        schema: 'qinglong/plugin-package-prompt-output-read-result@v1',
        status: 'not_found',
      };
    },
  });
  assert.equal((await route.handle(authorized(), {
    projectId: 'project-1', runId: 'run-1', artifactId: ARTIFACT_ID,
  })).statusCode, 404);
  assert.equal(calls, 1);

  assert.equal((await route.handle(authorized({ artifact_digest: ['bad'] }), {
    projectId: 'project-1', runId: 'run-1', artifactId: ARTIFACT_ID,
  })).statusCode, 400);
  assert.equal(calls, 1);
});

test('fails closed when capability widens or drifts from the requested identity', async () => {
  const route = createClusterControlPluginPackagePromptOutputReadRoute({
    async read(command) {
      return available(command, {
        reference: {
          ...available(command).reference,
          projectId: 'project-other',
        },
      });
    },
  });
  const result = await route.handle(authorized(), {
    projectId: 'project-1', runId: 'run-1', artifactId: ARTIFACT_ID,
  });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { code: 'prompt_output_read_unavailable' });
});
