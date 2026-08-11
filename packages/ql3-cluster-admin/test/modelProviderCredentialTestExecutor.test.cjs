const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestExecution,
  createModelProviderCredentialTestPlan,
} = require('@qinglong/ai/model-provider-credential-test-connection');
const {
  ModelProviderCredentialTestExecutionUnavailableError,
} = require('@qinglong/ai/postgres-model-provider-credential-test-connection');
const {
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
} = require('@qinglong/ai/provider-credential');
const {
  createModelProviderCredentialTestExecutor,
} = require('@qinglong/cluster-admin/model-provider-credential-test-executor');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

function fixture({
  maxModels = 4,
  providerFailure = false,
  transportReadiness = false,
  useDefaultClock = false,
} = {}) {
  const events = [];
  const allowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [
      {
        provider: 'openai-compatible',
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.example.test/v1/',
        revision: 'endpoint-v1',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  const plan = createModelProviderCredentialTestPlan({
    testId: randomUUID(),
    requestId: `request-${randomUUID()}`,
    projectId: 'project-a',
    provider: 'openai-compatible',
    endpoint: allowlist.providers[0],
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    plannedAtMs: 100,
    expiresAtMs: 60_100,
  });
  const executionId = randomUUID();
  const state = { execution: null, result: null, loseCompletion: false };
  const repository = {
    async beginExecution(input) {
      events.push('begin');
      if (state.execution) {
        return {
          status: 'existing',
          plan,
          execution: state.execution,
          result: state.result,
        };
      }
      state.execution = createModelProviderCredentialTestExecution({
        executionId: input.executionId,
        testId: input.testId,
        planDigest: plan.planDigest,
        startedAtMs: 200,
      });
      events.push('intent-committed');
      return {
        status: 'created',
        plan,
        execution: state.execution,
        result: null,
      };
    },
    async complete(result) {
      events.push('complete');
      if (!state.result) state.result = result;
      if (state.loseCompletion) {
        state.loseCompletion = false;
        throw new ModelProviderCredentialTestExecutionUnavailableError();
      }
      return {
        status: state.result === result ? 'created' : 'existing',
        result: state.result,
      };
    },
  };
  const secretRef = createSecretRef({
    projectId: 'project-a',
    name: 'openai-token',
  });
  const credentials = {
    async resolveModelProviderCredentialBinding() {
      events.push('binding');
      return {
        schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
        projectId: 'project-a',
        provider: 'openai-compatible',
        revision: 'credential-v1',
        secretRef,
        scheme: 'bearer',
      };
    },
    async record(record) {
      events.push('audit');
      assert.equal(record.requestId, executionId);
      assert.equal(record.operation, 'list_models');
    },
  };
  const secrets = {
    async resolveProjectSecretMaterial() {
      events.push('secret');
      const bytes = Buffer.from('provider-token');
      return {
        secretRef,
        bytes,
        dispose() {
          events.push('secret-disposed');
          bytes.fill(0);
        },
      };
    },
  };
  let fetchCalls = 0;
  let modelCount = 2;
  let monotonic = 0;
  const executor = createModelProviderCredentialTestExecutor({
    repository,
    credentials,
    secrets,
    now: () => 1_000,
    ...(useDefaultClock
      ? {}
      : {
          monotonicNow: () => {
            monotonic += 10;
            return monotonic;
          },
        }),
    ...(transportReadiness
      ? {
          async transportReady(baseUrl, signal) {
            events.push('transport-ready');
            assert.equal(baseUrl, 'https://provider.example.test/v1/');
            assert.equal(signal.aborted, false);
          },
        }
      : {}),
    async fetch(url, init) {
      events.push('fetch');
      fetchCalls += 1;
      assert.equal(
        events.indexOf('intent-committed') < events.indexOf('fetch'),
        true,
      );
      assert.equal(events.indexOf('audit') < events.indexOf('fetch'), true);
      assert.equal(url.toString(), 'https://provider.example.test/v1/models');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, 'Bearer provider-token');
      if (providerFailure) throw new Error('provider unavailable');
      return new Response(
        JSON.stringify({
          data: Array.from({ length: modelCount }, (_, index) => ({
            id: `model-${index + 1}`,
          })),
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  return {
    allowlist,
    plan,
    executionId,
    events,
    executor,
    state,
    fetchCalls: () => fetchCalls,
    setModelCount(value) {
      modelCount = value;
    },
  };
}

function input(value) {
  return {
    executionId: value.executionId,
    testId: value.plan.testId,
    allowlist: value.allowlist,
  };
}

test('commits intent and credential-use audit before exactly one provider call', async () => {
  const value = fixture();
  const result = await value.executor.execute(input(value));
  assert.equal(result.status, 'completed');
  assert.equal(result.result.outcome, 'reachable');
  assert.equal(result.result.modelCount, 2);
  assert.equal(value.fetchCalls(), 1);
  assert.equal(value.events.filter((event) => event === 'complete').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /provider-token|secretRef/i);
});

test('default monotonic clock retains its performance receiver', async () => {
  const value = fixture({ useDefaultClock: true });
  const result = await value.executor.execute(input(value));

  assert.equal(result.status, 'completed');
  assert.equal(result.result.outcome, 'reachable');
  assert.equal(Number.isSafeInteger(result.result.durationMs), true);
});

test('waits for credential-free transport readiness after durable intent', async () => {
  const value = fixture({ transportReadiness: true });
  const result = await value.executor.execute(input(value));

  assert.equal(result.result.outcome, 'reachable');
  assert.equal(
    value.events.indexOf('intent-committed') <
      value.events.indexOf('transport-ready'),
    true,
  );
  assert.equal(
    value.events.indexOf('transport-ready') < value.events.indexOf('binding'),
    true,
  );
});

test('existing intent without result is outcome_unknown and never reaches provider', async () => {
  const value = fixture();
  value.state.execution = createModelProviderCredentialTestExecution({
    executionId: value.executionId,
    testId: value.plan.testId,
    planDigest: value.plan.planDigest,
    startedAtMs: 200,
  });
  const result = await value.executor.execute(input(value));
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.result, null);
  assert.equal(value.fetchCalls(), 0);
  assert.deepEqual(value.events, ['begin']);
});

test('provider failure and response budget excess persist unreachable only', async () => {
  const failed = fixture({ providerFailure: true });
  const unavailable = await failed.executor.execute(input(failed));
  assert.equal(unavailable.result.outcome, 'unreachable');
  assert.equal(unavailable.result.modelCount, null);

  const oversized = fixture({ maxModels: 1 });
  oversized.setModelCount(2);
  const bounded = await oversized.executor.execute(input(oversized));
  assert.equal(bounded.result.outcome, 'unreachable');
  assert.equal(bounded.result.modelCount, null);
  assert.equal(oversized.fetchCalls(), 1);
});

test('completion COMMIT response loss retries only the exact result', async () => {
  const value = fixture();
  value.state.loseCompletion = true;
  const result = await value.executor.execute(input(value));
  assert.equal(result.status, 'completed');
  assert.equal(value.fetchCalls(), 1);
  assert.equal(value.events.filter((event) => event === 'complete').length, 2);
  const replay = await value.executor.execute(input(value));
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.result, result.result);
  assert.equal(value.fetchCalls(), 1);
});
