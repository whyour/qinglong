const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackageLifecycleImpact,
  pluginPackageLifecycleReferenceGraphDigest,
} = require('@qinglong/runtime-core/plugin-package-lifecycle');
const {
  InvalidPluginPackageLifecyclePlanError,
  createPluginPackageLifecyclePlan,
  normalizePluginPackageLifecyclePlan,
} = require('@qinglong/runtime-core/plugin-package-lifecycle-plan');

function impact() {
  const graph = {
    target: {
      projectId: 'default',
      packageName: 'cluster-monitor',
      installationId: 'install-cluster-monitor',
      lockDigest: '1'.repeat(64),
      installVersion: 1,
      installRecordDigest: '2'.repeat(64),
    },
    generationDigest: '3'.repeat(64),
    materializedRevisionDigest: '4'.repeat(64),
    taskIds: ['collect'],
    resourceCounts: {
      tasks: 1,
      tools: 0,
      workflows: 0,
      prompts: 0,
    },
    blockingReferences: [],
  };
  return createPluginPackageLifecycleImpact({
    action: 'disable',
    ...graph,
    expected: {
      version: 0,
      disposition: 'active',
      eventDigest: null,
    },
    currentToolSnapshotDigest: '5'.repeat(64),
    referenceGraphDigest: pluginPackageLifecycleReferenceGraphDigest(graph),
  });
}

test('creates one canonical short-lived Cluster lifecycle plan', () => {
  const plan = createPluginPackageLifecyclePlan({
    actionRef: 'lifecycle-plan:cluster-monitor-v1',
    impact: impact(),
    requestedBy: { type: 'user', id: 'cluster-owner' },
    plannedAtMs: 10_000,
    expiresAtMs: 20_000,
  });
  assert.deepEqual(normalizePluginPackageLifecyclePlan(plan), plan);
  assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(plan.impact.action, 'disable');
});

test('rejects digest drift, weak subjects and an unbounded lifetime', () => {
  const plan = createPluginPackageLifecyclePlan({
    actionRef: 'lifecycle-plan:cluster-monitor-v1',
    impact: impact(),
    requestedBy: { type: 'user', id: 'cluster-owner' },
    plannedAtMs: 10_000,
    expiresAtMs: 20_000,
  });
  assert.throws(
    () =>
      normalizePluginPackageLifecyclePlan({
        ...plan,
        planDigest: 'f'.repeat(64),
      }),
    InvalidPluginPackageLifecyclePlanError,
  );
  assert.throws(
    () =>
      createPluginPackageLifecyclePlan({
        actionRef: plan.actionRef,
        impact: plan.impact,
        requestedBy: { type: 'system', id: 'executor' },
        plannedAtMs: plan.plannedAtMs,
        expiresAtMs: plan.expiresAtMs,
      }),
    InvalidPluginPackageLifecyclePlanError,
  );
  assert.throws(
    () =>
      createPluginPackageLifecyclePlan({
        actionRef: plan.actionRef,
        impact: plan.impact,
        requestedBy: plan.requestedBy,
        plannedAtMs: plan.plannedAtMs,
        expiresAtMs: plan.plannedAtMs + 15 * 60 * 1000 + 1,
      }),
    InvalidPluginPackageLifecyclePlanError,
  );
});
