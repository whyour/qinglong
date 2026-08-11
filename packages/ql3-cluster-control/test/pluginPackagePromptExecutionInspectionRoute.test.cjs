const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createClusterControlPluginPackagePromptExecutionInspectionRoute,
} = require('@qinglong/cluster-control/prompt-routes');

function authorized(body = null) {
  return {
    request: {
      requestId: '00000000-0000-4000-8000-000000000001',
      method: 'GET',
      path: '/api/v3/projects/project-1/packages/example/prompts/summary/executions/execution-request-1',
      query: {},
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'user', id: 'owner-1' },
      authenticationId: 'api_credential:credential-1:1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'multi_factor',
    },
    operationId: 'prompt.execution.read',
    permission: 'run.read',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
  };
}

const parameters = {
  projectId: 'project-1',
  packageName: 'example',
  promptId: 'summary',
  executionRequestId: 'execution-request-1',
};

function found(command) {
  return {
    schema: 'qinglong/plugin-package-prompt-execution-inspection@v1',
    found: true,
    projectId: command.projectId,
    packageName: command.packageName,
    promptId: command.promptId,
    executionRequestId: command.executionRequestId,
    execution: {
      invocationId: 'invocation-1',
      runId: '00000000-0000-4000-8000-000000000010',
      stepRunId: 'step-1',
      runStatus: 'succeeded',
      runVersion: 5,
      eventSequence: 5,
      stepStatus: 'succeeded',
      stepVersion: 3,
      admittedAtMs: 1_000,
      startedAtMs: 1_000,
      finishedAtMs: 1_500,
      finalizedAtMs: 1_500,
    },
  };
}

test('reads one content-free Prompt execution by caller-known requestId', async () => {
  let command;
  const route = createClusterControlPluginPackagePromptExecutionInspectionRoute(
    {
      async inspectAuthorized(value) {
        command = value;
        return found(value);
      },
    },
    {
      now: () => 2_000,
      createEventId: () => '00000000-0000-4000-8000-000000000002',
    },
  );
  assert.equal(route.operationId, 'prompt.execution.read');
  assert.equal(route.permission, 'run.read');
  const result = await route.handle(authorized(), parameters);
  assert.equal(result.statusCode, 200);
  assert.equal(command.executionRequestId, 'execution-request-1');
  assert.equal(command.audit.operationId, 'prompt.execution.read');
  assert.equal(JSON.stringify(result).includes('template'), false);
  assert.equal(JSON.stringify(result).includes('parameter'), false);
});

test('masks cross-target absence and maps an authorization fence race', async () => {
  let calls = 0;
  const missing = createClusterControlPluginPackagePromptExecutionInspectionRoute(
    {
      async inspectAuthorized(command) {
        calls += 1;
        return { ...found(command), found: false, execution: null };
      },
    },
    {
      now: () => 2_000,
      createEventId: () => '00000000-0000-4000-8000-000000000002',
    },
  );
  assert.deepEqual(await missing.handle(authorized({ widened: true }), parameters), {
    statusCode: 400,
    body: { code: 'invalid_request_body' },
  });
  assert.equal(calls, 0);
  assert.deepEqual(await missing.handle(authorized(), parameters), {
    statusCode: 404,
    body: { code: 'prompt_execution_not_found' },
  });

  const conflict = createClusterControlPluginPackagePromptExecutionInspectionRoute(
    {
      async inspectAuthorized() {
        throw Object.assign(new Error('drift'), {
          code: 'PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_AUTHORIZATION_FENCE_CONFLICT',
        });
      },
    },
    {
      now: () => 2_000,
      createEventId: () => '00000000-0000-4000-8000-000000000003',
    },
  );
  assert.deepEqual(await conflict.handle(authorized(), parameters), {
    statusCode: 409,
    body: { code: 'authorization_fence_conflict' },
  });
});
