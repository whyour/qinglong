const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidWorkerCredentialManagementPlanError,
  createWorkerCredentialManagementPlan,
  normalizeWorkerCredentialManagementPlan,
} = require('@qinglong/runtime-core/worker-credential-management-plan');

const BASE = Object.freeze({
  actionRef: 'worker-credential:worker-a:generation-2',
  authorityProjectId: 'cluster-instance-authority',
  action: 'rotate',
  target: Object.freeze({
    deliveryId: '123e4567-e89b-42d3-a456-426614174702',
    workerId: 'worker-a',
    credentialId: 'credential-b',
    previousCredentialId: 'credential-a',
    credentialNotBeforeAtMs: 11_000,
    credentialExpiresAtMs: 21_000,
    deploymentTargetDigest: '1'.repeat(64),
    deploymentGeneration: 'generation-2',
  }),
  requestedBy: Object.freeze({ type: 'user', id: 'operator-a' }),
  plannedAtMs: 10_000,
  expiresAtMs: 20_000,
});

test('creates one immutable secret-free Worker credential rotation plan', () => {
  const plan = createWorkerCredentialManagementPlan(BASE);
  assert.deepEqual(normalizeWorkerCredentialManagementPlan(plan), plan);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.target), true);
  assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
  assert.match(plan.previewDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(plan.planDigest, plan.previewDigest);
  assert.doesNotMatch(JSON.stringify(plan), /token|kubeconfig|secret/i);
});

test('supports first issue only when no previous credential is bound', () => {
  const plan = createWorkerCredentialManagementPlan({
    ...BASE,
    action: 'issue',
    target: { ...BASE.target, previousCredentialId: null },
  });
  assert.equal(plan.action, 'issue');
  assert.equal(plan.target.previousCredentialId, null);
});

test('rejects action/predecessor mismatch, secret-shaped input and invalid lifetime', () => {
  assert.throws(
    () => createWorkerCredentialManagementPlan({
      ...BASE,
      action: 'issue',
    }),
    InvalidWorkerCredentialManagementPlanError,
  );
  assert.throws(
    () => createWorkerCredentialManagementPlan({
      ...BASE,
      target: { ...BASE.target, token: 'must-not-be-stored' },
    }),
    InvalidWorkerCredentialManagementPlanError,
  );
  assert.throws(
    () => createWorkerCredentialManagementPlan({
      ...BASE,
      expiresAtMs: BASE.plannedAtMs + 15 * 60 * 1000 + 1,
    }),
    InvalidWorkerCredentialManagementPlanError,
  );
});

test('rejects digest drift, weak requester and credential identity reuse', () => {
  const plan = createWorkerCredentialManagementPlan(BASE);
  assert.throws(
    () => normalizeWorkerCredentialManagementPlan({
      ...plan,
      planDigest: 'f'.repeat(64),
    }),
    InvalidWorkerCredentialManagementPlanError,
  );
  assert.throws(
    () => createWorkerCredentialManagementPlan({
      ...BASE,
      requestedBy: { type: 'system', id: 'controller' },
    }),
    InvalidWorkerCredentialManagementPlanError,
  );
  assert.throws(
    () => createWorkerCredentialManagementPlan({
      ...BASE,
      target: {
        ...BASE.target,
        previousCredentialId: BASE.target.credentialId,
      },
    }),
    InvalidWorkerCredentialManagementPlanError,
  );
});
