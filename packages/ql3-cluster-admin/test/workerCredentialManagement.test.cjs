const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  WorkerCredentialManagementAuthorizationError,
  WorkerCredentialManagementConflictError,
  WorkerCredentialManagementRequestError,
  createClusterWorkerCredentialManagementService,
} = require('@qinglong/cluster-admin/worker-credential-management');

const NOW = 1_000;
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'operator-a' }),
  authenticationId: 'session-operator-a',
  authenticatedAtMs: 900,
  expiresAtMs: 20_000,
  assurance: 'multi_factor',
});

function fixture() {
  const plans = new Map();
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM "ql3"."projects" AS project')) {
        return {
          rows: [{
            projectId: 'cluster-authority',
            projectName: 'Cluster Authority',
            projectSlug: 'cluster-authority',
            projectStatus: 'active',
            projectVersion: 3,
            projectCreatedAtMs: 1,
            projectUpdatedAtMs: 2,
            bindingProjectId: 'cluster-authority',
            bindingSubjectType: 'user',
            bindingSubjectId: 'operator-a',
            bindingVersion: 2,
            bindingState: 'active',
            bindingRole: 'admin',
            bindingMutationId: 'binding-operator-a-v2',
            bindingChangedByType: 'user',
            bindingChangedById: 'owner-a',
            bindingCreatedAtMs: 2,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT plan_json')) {
        const plan = plans.get(values[0]);
        return {
          rows: plan ? [{ planJson: plan }] : [],
          rowCount: plan ? 1 : 0,
        };
      }
      if (text.includes('INSERT INTO "ql3"."worker_credential_management_plans"')) {
        const actionRef = values[0];
        if (plans.has(actionRef)) return { rows: [], rowCount: 0 };
        plans.set(actionRef, JSON.parse(values[17]));
        return { rows: [{ actionRef }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async connect() {
      throw new Error('transaction is not expected by plan');
    },
  };
  return { pool, plans, queries };
}

function request(overrides = {}) {
  return {
    actionRef: 'worker-credential:worker-a:generation-2',
    authorityProjectId: 'cluster-authority',
    action: 'rotate',
    deliveryId: '123e4567-e89b-42d3-a456-426614174702',
    workerId: 'worker-a',
    credentialId: 'credential-b',
    previousCredentialId: 'credential-a',
    credentialNotBeforeAtMs: NOW,
    credentialExpiresAtMs: 100_000,
    deploymentTargetDigest: '1'.repeat(64),
    deploymentGeneration: 'generation-2',
    principal: PRINCIPAL,
    ...overrides,
  };
}

test('plans one immutable Worker credential rotation under a strong User fence', async () => {
  const state = fixture();
  const service = createClusterWorkerCredentialManagementService({
    pool: state.pool,
    now: () => NOW,
    planLifetimeMs: 10_000,
  });
  const created = await service.plan(request());
  const replay = await service.plan(request());

  assert.equal(created.status, 'created');
  assert.equal(replay.status, 'existing');
  assert.equal(created.plan.requestedBy.type, 'user');
  assert.equal(created.plan.requestedBy.id, 'operator-a');
  assert.equal(created.plan.plannedAtMs, NOW);
  assert.equal(created.plan.expiresAtMs, 11_000);
  assert.equal(created.plan.target.credentialNotBeforeAtMs, NOW);
  assert.match(created.plan.planDigest, /^[0-9a-f]{64}$/);
  assert.match(created.plan.previewDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(created.plan), /token|kubeconfig|secret/i);
  assert.equal(state.plans.size, 1);
});

test('rejects weak Users and widened manager configuration before persistence', async () => {
  const state = fixture();
  const service = createClusterWorkerCredentialManagementService({
    pool: state.pool,
    now: () => NOW,
  });
  await assert.rejects(
    service.plan(request({
      principal: { ...PRINCIPAL, assurance: 'single_factor' },
    })),
    WorkerCredentialManagementAuthorizationError,
  );
  assert.equal(state.plans.size, 0);

  assert.throws(
    () => createClusterWorkerCredentialManagementService({
      pool: state.pool,
      debug: true,
    }),
    WorkerCredentialManagementRequestError,
  );
});

test('maps invalid plans and semantic replay drift to stable management errors', async () => {
  const state = fixture();
  const service = createClusterWorkerCredentialManagementService({
    pool: state.pool,
    now: () => NOW,
  });
  await assert.rejects(
    service.plan(request({ credentialNotBeforeAtMs: NOW - 1 })),
    WorkerCredentialManagementRequestError,
  );
  await service.plan(request());
  await assert.rejects(
    service.plan(request({ deploymentGeneration: 'generation-3' })),
    WorkerCredentialManagementConflictError,
  );
  assert.equal(state.plans.size, 1);
});
