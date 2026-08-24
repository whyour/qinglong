const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_LEGACY_ENV_MIGRATION_PLAN_SCHEMA,
  MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BYTES,
  MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BINDINGS,
  MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS,
  MAX_CLUSTER_LEGACY_ENV_TASKS,
  MAX_CLUSTER_LEGACY_ENV_TRIGGERS,
  InvalidClusterLegacyEnvMigrationPlanError,
  clusterLegacyEnvMigrationPlanMatchesIntent,
  createClusterLegacyEnvMigrationPlan,
  normalizeClusterLegacyEnvMigrationPlan,
  normalizeClusterLegacyEnvMigrationPlanIntent,
} = require('@qinglong/runtime-core/cluster-legacy-env-migration-plan');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const DIGESTS = Object.freeze({
  reconciliationBundleDigest: '1'.repeat(64),
  decisionDigest: '2'.repeat(64),
  candidateSetDigest: '3'.repeat(64),
  taskRevisionSetDigest: '4'.repeat(64),
  triggerRevisionSetDigest: '5'.repeat(64),
});

function intent(overrides = {}) {
  const projectId = overrides.projectId ?? 'project-a';
  return {
    planId: 'legacy-env-plan-a',
    mutationId: 'legacy-env-mutation-a',
    projectId,
    source: {
      reconciliationBundleDigest: DIGESTS.reconciliationBundleDigest,
      decisionDigest: DIGESTS.decisionDigest,
      candidateSetDigest: DIGESTS.candidateSetDigest,
      sourceRowCount: 4,
      activeRowCount: 3,
      disabledRowCount: 1,
      effectiveBindingCount: 2,
    },
    target: {
      secretRef: createSecretRef({
        projectId,
        name: 'legacy-env-bundle',
        version: 7,
      }),
      taskRevisionSetDigest: DIGESTS.taskRevisionSetDigest,
      triggerRevisionSetDigest: DIGESTS.triggerRevisionSetDigest,
      taskCount: 2,
      triggerCount: 3,
      totalEffectiveBytes: 1024,
    },
    ...overrides,
  };
}

test('creates one frozen content-free migration plan with a stable digest', () => {
  const value = createClusterLegacyEnvMigrationPlan(intent(), 12_345);
  assert.equal(value.schema, CLUSTER_LEGACY_ENV_MIGRATION_PLAN_SCHEMA);
  assert.match(value.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.source), true);
  assert.equal(Object.isFrozen(value.target), true);
  assert.deepEqual(normalizeClusterLegacyEnvMigrationPlan(value), value);
  assert.equal(
    clusterLegacyEnvMigrationPlanMatchesIntent(value, intent()),
    true,
  );
  assert.deepEqual(Object.keys(value).sort(), [
    'mutationId',
    'planDigest',
    'planId',
    'plannedAtMs',
    'projectId',
    'schema',
    'source',
    'target',
  ]);
  assert.equal(JSON.stringify(value).includes('legacy-env-bundle'), false);
});

test('requires a canonical version-pinned SecretRef in the same Project', () => {
  const unversioned = intent();
  unversioned.target.secretRef = createSecretRef({
    projectId: unversioned.projectId,
    name: 'legacy-env-bundle',
  });
  assert.throws(
    () => normalizeClusterLegacyEnvMigrationPlanIntent(unversioned),
    InvalidClusterLegacyEnvMigrationPlanError,
  );

  const crossProject = intent();
  crossProject.target.secretRef = createSecretRef({
    projectId: 'project-b',
    name: 'legacy-env-bundle',
    version: 1,
  });
  assert.throws(
    () => normalizeClusterLegacyEnvMigrationPlanIntent(crossProject),
    InvalidClusterLegacyEnvMigrationPlanError,
  );
});

test('enforces source consistency and router-safe bounded targets', () => {
  const invalidValues = [
    { source: { ...intent().source, sourceRowCount: 5 } },
    {
      source: {
        ...intent().source,
        sourceRowCount: MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS + 1,
      },
    },
    {
      source: {
        ...intent().source,
        sourceRowCount: MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BINDINGS + 1,
        activeRowCount: MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BINDINGS + 1,
        disabledRowCount: 0,
        effectiveBindingCount: MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BINDINGS + 1,
      },
    },
    {
      target: {
        ...intent().target,
        taskCount: MAX_CLUSTER_LEGACY_ENV_TASKS + 1,
      },
    },
    {
      target: {
        ...intent().target,
        triggerCount: MAX_CLUSTER_LEGACY_ENV_TRIGGERS + 1,
      },
    },
    {
      target: {
        ...intent().target,
        totalEffectiveBytes: MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BYTES + 1,
      },
    },
  ];
  for (const invalidValue of invalidValues) {
    assert.throws(
      () => normalizeClusterLegacyEnvMigrationPlanIntent(intent(invalidValue)),
      InvalidClusterLegacyEnvMigrationPlanError,
    );
  }
});

test('rejects widened shapes, accessors, symbols and tampered durable digests', () => {
  const widened = intent();
  widened.source.envName = 'TOKEN';
  assert.throws(
    () => normalizeClusterLegacyEnvMigrationPlanIntent(widened),
    InvalidClusterLegacyEnvMigrationPlanError,
  );

  const symbol = intent();
  symbol.target[Symbol('secretValue')] = 'not-storable';
  assert.throws(
    () => normalizeClusterLegacyEnvMigrationPlanIntent(symbol),
    InvalidClusterLegacyEnvMigrationPlanError,
  );

  const accessor = intent();
  Object.defineProperty(accessor.source, 'sourceRowCount', {
    enumerable: true,
    get() {
      return 4;
    },
  });
  assert.throws(
    () => normalizeClusterLegacyEnvMigrationPlanIntent(accessor),
    InvalidClusterLegacyEnvMigrationPlanError,
  );

  const plan = createClusterLegacyEnvMigrationPlan(intent(), 12_345);
  assert.throws(
    () =>
      normalizeClusterLegacyEnvMigrationPlan({
        ...plan,
        planDigest: 'f'.repeat(64),
      }),
    InvalidClusterLegacyEnvMigrationPlanError,
  );
});
