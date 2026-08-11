const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestPlan,
} = require('../dist/model-provider-credential/modelProviderCredentialTestConnection.js');
const {
  MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
  ModelProviderCredentialTestPlanAuthorizationFenceConflictError,
  ModelProviderCredentialTestPlanQuotaExceededError,
  ModelProviderCredentialTestPlanUnavailableError,
  PostgresModelProviderCredentialTestPlanRepository,
} = require('../dist/model-provider-credential/postgresModelProviderCredentialTestConnection.js');

function plan(overrides = {}) {
  const endpoint = createModelProviderCredentialTestAllowlist({
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
  }).providers[0];
  return createModelProviderCredentialTestPlan({
    testId: randomUUID(),
    requestId: `request-${randomUUID()}`,
    projectId: 'project-a',
    provider: endpoint.provider,
    endpoint,
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 1, bindingVersion: 1 },
    plannedAtMs: 100,
    expiresAtMs: 60_100,
    ...overrides,
  });
}

function authorized(value) {
  return {
    plan: value,
    audit: {
      eventId: value.testId,
      requestId: value.requestId,
      operationId: MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
      projectId: value.projectId,
      subject: value.requestedBy,
      authenticationId: 'strong-authentication-1',
      outcome: 'allowed',
      reasons: ['project_owner'],
      fence: value.fence,
      occurredAtMs: value.plannedAtMs,
    },
  };
}

function fixture({ projectVersion = 1, bindingVersion = 1 } = {}) {
  const state = {
    plans: new Map(),
    audits: new Map(),
    quota: { consumed: 0, receipts: new Set() },
  };
  let snapshot;
  let loseCommit = false;
  const client = {
    async query(text, values = []) {
      if (text.startsWith('BEGIN')) {
        snapshot = structuredClone(state);
        return { rows: [] };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (text.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: projectVersion }] };
      }
      if (text.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: bindingVersion }] };
      }
      if (
        text.includes('FROM "ql3_ai"."model_provider_credential_test_plans"')
      ) {
        const [testId, requestedProjectId, requestId] = values;
        const rows = [...state.plans.values()]
          .filter(
            (stored) =>
              stored.testId === testId ||
              (stored.projectId === requestedProjectId &&
                stored.requestId === requestId),
          )
          .map((stored) => ({ planJson: stored }));
        return { rows };
      }
      if (text.includes('FROM "ql3"."security_audit_events"')) {
        const stored = state.audits.get(values[0]);
        return { rows: stored ? [stored] : [] };
      }
      if (text.includes('receipt_ids ? $3::text AS "hasReceipt"')) {
        return {
          rows:
            state.quota.consumed === 0
              ? []
              : [{ hasReceipt: state.quota.receipts.has(values[2]) }],
        };
      }
      if (
        text.startsWith('WITH database_clock AS (') &&
        text.includes('INSERT INTO')
      ) {
        const receipt = values[2];
        const limit = values[4];
        if (
          !state.quota.receipts.has(receipt) &&
          state.quota.consumed >= limit
        ) {
          return { rows: [] };
        }
        if (!state.quota.receipts.has(receipt)) {
          state.quota.receipts.add(receipt);
          state.quota.consumed += 1;
        }
        return {
          rows: [
            {
              consumedCount: state.quota.consumed,
              resetAtMs: 60_100,
              observedAtMs: 100,
            },
          ],
        };
      }
      if (
        text.startsWith('WITH database_clock AS (') &&
        text.includes('SELECT consumed_count')
      ) {
        return {
          rows: [
            {
              consumedCount: state.quota.consumed,
              resetAtMs: 60_100,
              observedAtMs: 100,
            },
          ],
        };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3_ai"."model_provider_credential_test_plans"',
        )
      ) {
        state.plans.set(values[0], JSON.parse(values[20]));
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO "ql3"."security_audit_events"')) {
        state.audits.set(values[0], {
          eventId: values[0],
          requestId: values[1],
          operationId: values[2],
          projectId: values[3],
          subjectType: values[4],
          subjectId: values[5],
          authenticationId: values[6],
          outcome: values[7],
          reasons: JSON.parse(values[8]),
          projectVersion: values[9],
          bindingVersion: values[10],
          occurredAtMs: values[11],
        });
        return { rows: [] };
      }
      if (text === 'COMMIT') {
        snapshot = undefined;
        if (loseCommit) {
          loseCommit = false;
          const error = new Error('lost commit response');
          error.code = 'ECONNRESET';
          throw error;
        }
        return { rows: [] };
      }
      if (text === 'ROLLBACK') {
        if (snapshot) {
          state.plans = snapshot.plans;
          state.audits = snapshot.audits;
          state.quota = snapshot.quota;
        }
        snapshot = undefined;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  return {
    repository: new PostgresModelProviderCredentialTestPlanRepository(
      {
        async connect() {
          return client;
        },
      },
      { quotaWindowMs: 60_000, quotaLimit: 2 },
    ),
    state: () => state,
    loseNextCommitResponse() {
      loseCommit = true;
    },
  };
}

test('atomically consumes quota, stores a plan and writes allowed audit', async () => {
  const value = fixture();
  const candidate = plan();
  const created = await value.repository.createAuthorized(
    authorized(candidate),
  );
  assert.equal(created.status, 'created');
  assert.equal(value.state().plans.size, 1);
  assert.equal(value.state().audits.size, 1);
  assert.equal(value.state().quota.consumed, 1);
  assert.equal(value.state().quota.receipts.has(candidate.testId), true);
});

test('converges a COMMIT response loss without consuming quota twice', async () => {
  const value = fixture();
  const candidate = plan();
  value.loseNextCommitResponse();
  await assert.rejects(
    value.repository.createAuthorized(authorized(candidate)),
    ModelProviderCredentialTestPlanUnavailableError,
  );
  const replay = await value.repository.createAuthorized(authorized(candidate));
  assert.equal(replay.status, 'existing');
  assert.equal(value.state().quota.consumed, 1);
});

test('replays the stored plan when API retry observes a later clock', async () => {
  const value = fixture();
  const candidate = plan();
  await value.repository.createAuthorized(authorized(candidate));
  const retried = plan({
    testId: candidate.testId,
    requestId: candidate.requestId,
    projectId: candidate.projectId,
    provider: candidate.provider,
    endpoint: candidate.endpoint,
    requestedBy: candidate.requestedBy,
    fence: candidate.fence,
    plannedAtMs: candidate.plannedAtMs + 25,
    expiresAtMs: candidate.expiresAtMs + 25,
  });
  const replay = await value.repository.createAuthorized(authorized(retried));
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.plan, candidate);
  assert.equal(value.state().quota.consumed, 1);
});

test('fails a stale fence and quota excess before creating another plan', async () => {
  const stale = fixture({ projectVersion: 2 });
  await assert.rejects(
    stale.repository.createAuthorized(authorized(plan())),
    ModelProviderCredentialTestPlanAuthorizationFenceConflictError,
  );
  assert.equal(stale.state().quota.consumed, 0);

  const limited = fixture();
  await limited.repository.createAuthorized(authorized(plan()));
  await limited.repository.createAuthorized(authorized(plan()));
  await assert.rejects(
    limited.repository.createAuthorized(authorized(plan())),
    ModelProviderCredentialTestPlanQuotaExceededError,
  );
  assert.equal(limited.state().plans.size, 2);
});
