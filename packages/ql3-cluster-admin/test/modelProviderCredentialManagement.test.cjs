const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
} = require('@qinglong/ai/model-provider-credential-administration');
const {
  createModelProviderCredentialTransition,
} = require('@qinglong/ai/model-provider-credential-catalog');
const {
  createModelProviderCredentialTestAllowlist,
} = require('@qinglong/ai/model-provider-credential-test-connection');
const {
  ClusterModelProviderCredentialManagementAuthenticationError,
  ClusterModelProviderCredentialManagementAuthorizationError,
  ClusterModelProviderCredentialManagementConflictError,
  ClusterModelProviderCredentialManagementRequestError,
  createClusterModelProviderCredentialManagementService,
} = require('../dist/model-provider-credential/modelProviderCredentialManagement.js');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const NOW_MS = 1_000_000;
const MUTATION_ID = '019f7094-a853-4f3b-82ab-dfa08e6bd1c1';

function principal(overrides = {}) {
  return {
    subject: { type: 'user', id: 'owner-a' },
    authenticationId: 'authentication-1',
    authenticatedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 60_000,
    assurance: 'multi_factor',
    ...overrides,
  };
}

function bindRequest(overrides = {}) {
  return {
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
    principal: principal(),
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = { policy: [], mutations: [], audits: [], testPlans: [] };
  const policy = {
    async authorize(...args) {
      calls.policy.push(args);
      return (
        overrides.decision ?? {
          effect: 'allow',
          reasons: ['project_owner'],
          fence: { projectVersion: 3, bindingVersion: 7 },
        }
      );
    },
  };
  const credentials = {
    async findCurrentTransition() {
      return null;
    },
    async commit() {
      throw new Error('raw commit must not be used');
    },
    async commitAuthorized(mutation) {
      calls.mutations.push(mutation);
      if (overrides.repositoryError) throw overrides.repositoryError;
      return {
        status: 'created',
        transition: createModelProviderCredentialTransition(
          mutation.command,
          null,
          NOW_MS,
        ),
      };
    },
  };
  const audit = {
    async listAuthorized(query) {
      calls.audits.push(query);
      if (overrides.auditError) throw overrides.auditError;
      return {
        projectId: query.query.projectId,
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
  };
  const testAllowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [
      {
        provider: 'openai-compatible',
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
  const testPlans = {
    async createAuthorized(value) {
      calls.testPlans.push(value);
      if (overrides.testPlanError) throw overrides.testPlanError;
      return { status: 'created', plan: value.plan };
    },
  };
  return {
    calls,
    service: createClusterModelProviderCredentialManagementService({
      policy,
      credentials,
      audit,
      testPlans,
      testAllowlist,
      testPlanLifetimeMs: 60_000,
      now: () => NOW_MS,
    }),
  };
}

test('test connection plan selects endpoint and hard budgets server-side', async () => {
  const { service, calls } = fixture();
  const testId = '319f7094-a853-4f3b-82ab-dfa08e6bd1c4';
  const result = await service.planTestConnection({
    requestId: 'test-request-1',
    testId,
    projectId: 'project-a',
    provider: 'openai-compatible',
    principal: principal(),
  });
  assert.equal(result.status, 'created');
  assert.equal(result.plan.testId, testId);
  assert.equal(
    result.plan.endpoint.baseUrl,
    'https://provider.example.test/v1/',
  );
  assert.equal(result.plan.endpoint.maxCostMicrousd, 0);
  assert.equal(result.plan.endpoint.retryLimit, 0);
  assert.equal(result.plan.expiresAtMs - result.plan.plannedAtMs, 60_000);
  assert.equal(calls.policy[0][2], 'secret.manage');
  assert.equal(calls.testPlans.length, 1);
  assert.equal(
    calls.testPlans[0].audit.operationId,
    'model_provider_credential.test.plan',
  );
  assert.doesNotMatch(JSON.stringify(calls.testPlans[0]), /secretRef|token/i);
});

test('test connection request cannot supply URL, budgets or SecretRef', async () => {
  const { service, calls } = fixture();
  const base = {
    requestId: 'test-request-1',
    testId: '419f7094-a853-4f3b-82ab-dfa08e6bd1c5',
    projectId: 'project-a',
    provider: 'openai-compatible',
    principal: principal(),
  };
  for (const widened of [
    { baseUrl: 'https://attacker.example/v1/' },
    { deadlineMs: 60_000 },
    { secretRef: 'qlsecret:project-a/openai-token' },
  ]) {
    await assert.rejects(
      service.planTestConnection({ ...base, ...widened }),
      ClusterModelProviderCredentialManagementRequestError,
    );
  }
  assert.equal(calls.policy.length, 0);
  assert.equal(calls.testPlans.length, 0);
});

test('bind derives actor and exact secret.manage authority server-side', async () => {
  const { service, calls } = fixture();
  const result = await service.bind(bindRequest());

  assert.equal(result.status, 'created');
  assert.equal(result.transition.activeBindingRevision, 'credential-v1');
  assert.equal(calls.policy.length, 1);
  assert.equal(calls.policy[0][1], 'project-a');
  assert.equal(calls.policy[0][2], 'secret.manage');
  assert.equal(calls.mutations.length, 1);
  assert.deepEqual(calls.mutations[0].command.changedBy, {
    type: 'user',
    id: 'owner-a',
  });
  assert.equal(calls.mutations[0].audit.outcome, 'allowed');
  assert.equal(
    calls.mutations[0].audit.operationId,
    'model_provider_credential.bind',
  );
  assert.equal(
    JSON.stringify(calls.mutations[0]).includes('authorization'),
    false,
  );
});

test('revoke is Project-fenced and cannot carry binding material', async () => {
  const { service, calls } = fixture();
  const request = bindRequest();
  const result = await service.revoke({
    requestId: 'request-2',
    mutationId: '119f7094-a853-4f3b-82ab-dfa08e6bd1c2',
    projectId: request.projectId,
    provider: request.provider,
    expectedGeneration: 0,
    principal: request.principal,
  });
  assert.equal(result.transition.action, 'revoke');
  assert.equal(calls.mutations[0].command.binding, null);
  assert.equal(
    calls.mutations[0].audit.operationId,
    'model_provider_credential.revoke',
  );
});

test('weak, stale and denied principals fail before repository mutation', async () => {
  for (const scenario of [
    {
      request: bindRequest({
        principal: principal({ assurance: 'single_factor' }),
      }),
      error: ClusterModelProviderCredentialManagementAuthenticationError,
    },
    {
      request: bindRequest({
        principal: principal({ authenticatedAtMs: NOW_MS - 300_001 }),
      }),
      error: ClusterModelProviderCredentialManagementAuthenticationError,
    },
    {
      decision: { effect: 'deny', reasons: ['policy_denied'], fence: null },
      request: bindRequest(),
      error: ClusterModelProviderCredentialManagementAuthorizationError,
    },
  ]) {
    const { service, calls } = fixture({ decision: scenario.decision });
    await assert.rejects(service.bind(scenario.request), scenario.error);
    assert.equal(calls.mutations.length, 0);
  }
});

test('request widening and durable fence drift fail closed', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.bind({
      ...bindRequest(),
      changedBy: { type: 'user', id: 'owner-b' },
    }),
    ClusterModelProviderCredentialManagementRequestError,
  );
  await assert.rejects(
    service.bind({ ...bindRequest(), secretRef: 'not-a-canonical-secret-ref' }),
    ClusterModelProviderCredentialManagementRequestError,
  );

  const conflict = fixture({
    repositoryError:
      new ModelProviderCredentialAdministrationAuthorizationFenceConflictError(),
  });
  await assert.rejects(
    conflict.service.bind(bindRequest()),
    ClusterModelProviderCredentialManagementConflictError,
  );
});

test('audit query reuses secret.manage and returns only content-free events', async () => {
  const { service, calls } = fixture();
  const result = await service.listAudit({
    requestId: 'audit-request-1',
    queryId: '219f7094-a853-4f3b-82ab-dfa08e6bd1c3',
    projectId: 'project-a',
    limit: 8,
    principal: principal(),
  });
  assert.equal(calls.policy.length, 1);
  assert.equal(calls.policy[0][2], 'secret.manage');
  assert.equal(calls.audits.length, 1);
  assert.equal(
    calls.audits[0].audit.operationId,
    'model_provider_credential.audit.list',
  );
  assert.deepEqual(calls.audits[0].fence, {
    projectVersion: 3,
    bindingVersion: 7,
  });
  assert.equal(result.records[0].operation, 'provider-credential.bind');
  assert.doesNotMatch(
    JSON.stringify(result),
    /secretRef|provider-token|bindingDigest|authenticationId|openai/i,
  );
});

test('invalid audit cursors fail before policy or storage', async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    service.listAudit({
      requestId: 'audit-request-1',
      queryId: '219f7094-a853-4f3b-82ab-dfa08e6bd1c3',
      projectId: 'project-a',
      limit: 8,
      before: { occurredAtMs: 1, eventId: 'not-a-uuid' },
      principal: principal(),
    }),
    ClusterModelProviderCredentialManagementRequestError,
  );
  assert.equal(calls.policy.length, 0);
  assert.equal(calls.audits.length, 0);
});
