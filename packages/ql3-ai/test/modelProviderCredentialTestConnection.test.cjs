const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const {
  InvalidModelProviderCredentialTestConnectionError,
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestExecution,
  createModelProviderCredentialTestPlan,
  createModelProviderCredentialTestResult,
  normalizeModelProviderCredentialTestAllowlist,
  normalizeModelProviderCredentialTestExecution,
  normalizeModelProviderCredentialTestPlan,
  normalizeModelProviderCredentialTestResult,
  resolveModelProviderCredentialTestEndpoint,
} = require('../dist/model-provider-credential/modelProviderCredentialTestConnection.js');

function endpoint(overrides = {}) {
  return {
    provider: 'openai-compatible',
    adapter: 'openai-compatible',
    baseUrl: 'https://provider.example.test/v1/',
    revision: 'provider-test-v1',
    deadlineMs: 5_000,
    maxResponseBytes: 64 * 1_024,
    maxModels: 64,
    maxCostMicrousd: 0,
    retryLimit: 0,
    ...overrides,
  };
}

function allowlist() {
  return createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [endpoint()],
  });
}

test('freezes an exact HTTPS allowlist with zero retry and zero cost', () => {
  const catalog = allowlist();
  assert.deepEqual(
    normalizeModelProviderCredentialTestAllowlist(catalog),
    catalog,
  );
  assert.equal(catalog.providers[0].retryLimit, 0);
  assert.equal(catalog.providers[0].maxCostMicrousd, 0);
  assert.equal(
    resolveModelProviderCredentialTestEndpoint(catalog, 'openai-compatible')
      .configDigest,
    catalog.providers[0].configDigest,
  );
  assert.throws(
    () =>
      createModelProviderCredentialTestAllowlist({
        revision: 'catalog-v1',
        providers: [endpoint({ baseUrl: 'http://metadata.internal/' })],
      }),
    InvalidModelProviderCredentialTestConnectionError,
  );
  assert.throws(
    () =>
      createModelProviderCredentialTestAllowlist({
        revision: 'catalog-v1',
        providers: [endpoint({ retryLimit: 1 })],
      }),
    InvalidModelProviderCredentialTestConnectionError,
  );
});

test('binds one short-lived plan to the server-selected endpoint and fence', () => {
  const selected = allowlist().providers[0];
  const plan = createModelProviderCredentialTestPlan({
    testId: randomUUID(),
    requestId: 'provider-test-request-1',
    projectId: 'project-a',
    provider: selected.provider,
    endpoint: selected,
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 7, bindingVersion: 9 },
    plannedAtMs: 1_000,
    expiresAtMs: 61_000,
  });
  assert.deepEqual(normalizeModelProviderCredentialTestPlan(plan), plan);
  assert.equal(JSON.stringify(plan).includes('secretRef'), false);
  assert.throws(
    () =>
      normalizeModelProviderCredentialTestPlan({
        ...plan,
        endpoint: { ...plan.endpoint, maxCostMicrousd: 1 },
      }),
    InvalidModelProviderCredentialTestConnectionError,
  );
});

test('creates immutable execution intent before a content-free result', () => {
  const testId = randomUUID();
  const executionId = randomUUID();
  const execution = createModelProviderCredentialTestExecution({
    executionId,
    testId,
    planDigest: 'a'.repeat(64),
    startedAtMs: 2_000,
  });
  assert.deepEqual(
    normalizeModelProviderCredentialTestExecution(execution),
    execution,
  );
  const result = createModelProviderCredentialTestResult({
    executionId,
    testId,
    planDigest: execution.planDigest,
    outcome: 'reachable',
    modelCount: 12,
    durationMs: 250,
    completedAtMs: 2_250,
  });
  assert.deepEqual(normalizeModelProviderCredentialTestResult(result), result);
  assert.deepEqual(Object.keys(result).sort(), [
    'completedAtMs',
    'durationMs',
    'executionId',
    'modelCount',
    'outcome',
    'planDigest',
    'resultDigest',
    'schema',
    'testId',
  ]);
  assert.throws(
    () =>
      createModelProviderCredentialTestResult({
        executionId,
        testId,
        planDigest: execution.planDigest,
        outcome: 'unreachable',
        modelCount: 1,
        durationMs: 250,
        completedAtMs: 2_250,
      }),
    InvalidModelProviderCredentialTestConnectionError,
  );
});
