const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createModelProviderCredentialTransition,
  createModelProviderCredentialTransitionCommand,
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
} = require('@qinglong/ai/model-provider-credential-catalog');
const {
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
} = require('@qinglong/ai/provider-credential');
const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestPlan,
} = require('@qinglong/ai/model-provider-credential-test-connection');
const {
  ClusterModelProviderCredentialManagementTransportAuthenticationError,
  ClusterModelProviderCredentialManagementTransportRequestError,
  createClusterModelProviderCredentialManagementTransport,
  normalizeClusterModelProviderCredentialManagementCommand,
} = require('../dist/model-provider-credential/modelProviderCredentialManagementTransport.js');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const NOW_MS = 1_000_000;
const MUTATION_ID = '019f7094-a853-4f3b-82ab-dfa08e6bd1c1';

function principal(overrides = {}) {
  return {
    subject: { type: 'user', id: 'owner-a' },
    authenticationId: 'authentication-1',
    authenticatedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 60_000,
    assurance: 'hardware',
    ...overrides,
  };
}

function bindCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'provider-credential.bind',
    request: {
      requestId: 'request-1',
      mutationId: MUTATION_ID,
      projectId: 'project-a',
      provider: 'openai-compatible',
      expectedGeneration: 0,
      revision: 'credential-v1',
      secretRef: createSecretRef({
        projectId: 'project-a',
        name: 'openai-token',
      }),
    },
    ...overrides,
  };
}

function auditCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'provider-credential.audit.list',
    request: {
      requestId: 'audit-request-1',
      queryId: '219f7094-a853-4f3b-82ab-dfa08e6bd1c3',
      projectId: 'project-a',
      limit: 8,
    },
    ...overrides,
  };
}

function testPlanCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'provider-credential.test.plan',
    request: {
      requestId: 'test-request-1',
      testId: '319f7094-a853-4f3b-82ab-dfa08e6bd1c4',
      projectId: 'project-a',
      provider: 'openai-compatible',
    },
    ...overrides,
  };
}

function testPlan(request) {
  const allowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [
      {
        provider: request.provider,
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.example.test/v1/',
        revision: 'endpoint-v1',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels: 64,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  return createModelProviderCredentialTestPlan({
    testId: request.testId,
    requestId: request.requestId,
    projectId: request.projectId,
    provider: request.provider,
    endpoint: allowlist.providers[0],
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    plannedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
  });
}

function transition(request, action) {
  const command = createModelProviderCredentialTransitionCommand({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId: request.mutationId,
    projectId: request.projectId,
    provider: request.provider,
    expectedGeneration: request.expectedGeneration,
    action,
    binding:
      action === 'bind'
        ? {
            schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
            projectId: request.projectId,
            provider: request.provider,
            revision: request.revision,
            secretRef: request.secretRef,
            scheme: 'bearer',
          }
        : null,
    changedBy: { type: 'user', id: 'owner-a' },
  });
  return createModelProviderCredentialTransition(command, null, NOW_MS);
}

function fixture() {
  const calls = [];
  const service = {
    async bind(request) {
      calls.push({ operation: 'bind', request });
      return {
        status: 'created',
        transition: transition(request, 'bind'),
      };
    },
    async revoke(request) {
      calls.push({ operation: 'revoke', request });
      return {
        status: 'created',
        transition: transition(request, 'revoke'),
      };
    },
    async listAudit(request) {
      calls.push({ operation: 'audit.list', request });
      return {
        projectId: request.projectId,
        records: [
          {
            eventId: MUTATION_ID,
            requestId: 'request-1',
            operation: 'provider-credential.bind',
            actor: { type: 'user', id: 'owner-a' },
            fence: { projectVersion: 3, bindingVersion: 7 },
            occurredAtMs: NOW_MS - 1,
          },
        ],
        nextCursor: null,
      };
    },
    async planTestConnection(request) {
      calls.push({ operation: 'test.plan', request });
      return { status: 'created', plan: testPlan(request) };
    },
  };
  return {
    calls,
    transport: createClusterModelProviderCredentialManagementTransport({
      service,
      now: () => NOW_MS,
    }),
  };
}

test('transport injects authenticated principal and returns content-free summary', async () => {
  const { transport, calls } = fixture();
  const result = await transport.execute(bindCommand(), {
    async authenticate() {
      return principal();
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.principal.subject.id, 'owner-a');
  assert.equal(result.operation, 'provider-credential.bind');
  assert.equal(result.credential.activeBindingRevision, 'credential-v1');
  assert.equal(JSON.stringify(result).includes('qlsecret:'), false);
  assert.equal(JSON.stringify(result).includes('openai-token'), false);
});

test('transport rejects caller-supplied identity and unknown operations', () => {
  assert.throws(
    () =>
      normalizeClusterModelProviderCredentialManagementCommand({
        ...bindCommand(),
        request: { ...bindCommand().request, principal: principal() },
      }),
    ClusterModelProviderCredentialManagementTransportRequestError,
  );
  assert.throws(
    () =>
      normalizeClusterModelProviderCredentialManagementCommand({
        ...bindCommand(),
        operation: 'provider-credential.inspect',
      }),
    ClusterModelProviderCredentialManagementTransportRequestError,
  );
});

test('transport rejects weak or stale authentication before service use', async () => {
  for (const candidate of [
    principal({ assurance: 'single_factor' }),
    principal({ authenticatedAtMs: NOW_MS - 300_001 }),
  ]) {
    const { transport, calls } = fixture();
    await assert.rejects(
      transport.execute(bindCommand(), {
        async authenticate() {
          return candidate;
        },
      }),
      ClusterModelProviderCredentialManagementTransportAuthenticationError,
    );
    assert.equal(calls.length, 0);
  }
});

test('transport returns an exact content-free audit page', async () => {
  const { transport, calls } = fixture();
  const result = await transport.execute(auditCommand(), {
    async authenticate() {
      return principal();
    },
  });
  assert.equal(calls[0].operation, 'audit.list');
  assert.equal(calls[0].request.principal.subject.id, 'owner-a');
  assert.equal(result.operation, 'provider-credential.audit.list');
  assert.equal(result.audit.records[0].operation, 'provider-credential.bind');
  assert.doesNotMatch(
    JSON.stringify(result),
    /secretRef|bindingDigest|transitionDigest|authenticationId|openai/i,
  );
});

test('transport injects identity into a server-bounded test plan', async () => {
  const { transport, calls } = fixture();
  const result = await transport.execute(testPlanCommand(), {
    async authenticate() {
      return principal();
    },
  });
  assert.equal(calls[0].operation, 'test.plan');
  assert.equal(calls[0].request.principal.subject.id, 'owner-a');
  assert.equal(result.operation, 'provider-credential.test.plan');
  assert.equal(result.plan.endpoint.maxCostMicrousd, 0);
  assert.equal(result.plan.endpoint.retryLimit, 0);
  assert.doesNotMatch(JSON.stringify(result), /secretRef|token/i);
});

test('transport rejects caller-controlled test endpoint and budgets', () => {
  for (const widened of [
    { baseUrl: 'https://attacker.example/v1/' },
    { deadlineMs: 60_000 },
    { secretRef: 'qlsecret:project-a/openai-token' },
  ]) {
    assert.throws(
      () =>
        normalizeClusterModelProviderCredentialManagementCommand({
          ...testPlanCommand(),
          request: { ...testPlanCommand().request, ...widened },
        }),
      ClusterModelProviderCredentialManagementTransportRequestError,
    );
  }
});

test('transport rejects widened audit filters before authentication', () => {
  assert.throws(
    () =>
      normalizeClusterModelProviderCredentialManagementCommand({
        ...auditCommand(),
        request: { ...auditCommand().request, provider: 'openai-compatible' },
      }),
    ClusterModelProviderCredentialManagementTransportRequestError,
  );
});
