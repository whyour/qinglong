'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackageSecretBindingApprovalPlanError,
  createPluginPackageSecretBindingApprovalPlan,
  createPluginPackageSecretBindingFromApprovalPlan,
  normalizePluginPackageSecretBindingApprovalPlan,
  pluginPackageSecretBindingApprovedAction,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan');
const {
  createPluginPackageSecretBindingPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-plan');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const manifest = {
  apiVersion: 'qinglong.io/v1alpha1',
  kind: 'Package',
  metadata: {
    name: 'example-monitor',
    displayName: 'Example Monitor',
    version: '1.0.0',
    description: 'Secret binding approval plan fixture',
    license: 'Apache-2.0',
  },
  spec: {
    compatibility: {
      qinglong: '>=3.0.0-0 <4.0.0',
      architectures: ['arm64'],
      deploymentProfiles: ['cluster-control'],
    },
    runtimes: [],
    resources: {
      memory: { recommended: '32Mi' },
      disk: { install: '4Mi', working: '8Mi' },
    },
    permissions: {
      network: { allowedHosts: [] },
      secrets: [{ name: 'TOKEN', required: true }],
      tools: ['secret.use'],
    },
    contents: { tasks: [], workflows: [], prompts: [], tools: [] },
  },
};

const generation = createPluginPackageResourceGeneration({
  installationId: 'install-1',
  projectId: 'project-1',
  packageName: 'example-monitor',
  lockDigest: 'a'.repeat(64),
  generation: 1,
  previousActiveLockDigest: null,
  contentDigest: 'b'.repeat(64),
  contents: manifest.spec.contents,
});

function approvalPlan() {
  const bindingPlan = createPluginPackageSecretBindingPlan({
    generation,
    manifest,
    assignments: [
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-1',
          name: 'runtime-token',
          version: 2,
        }),
      },
    ],
    plannedAtMs: 10_000,
  });
  return createPluginPackageSecretBindingApprovalPlan({
    actionRef: 'secret-binding:example-monitor-v1',
    bindingPlan,
    requestedBy: { type: 'user', id: 'cluster-owner' },
    expiresAtMs: 20_000,
  });
}

test('binds one short-lived Cluster approval to the exact Secret plan', () => {
  const plan = approvalPlan();
  assert.deepEqual(normalizePluginPackageSecretBindingApprovalPlan(plan), plan);
  assert.match(plan.approvalPlanDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(plan).includes('secret-value'), false);
  assert.equal(Object.isFrozen(plan), true);

  const action = pluginPackageSecretBindingApprovedAction(plan);
  assert.deepEqual(action, {
    permission: 'secret.manage',
    actionType: 'plugin_package.secret_binding.bind',
    actionRef: plan.actionRef,
    actionDigest: plan.approvalPlanDigest,
    previewDigest: plan.bindingPlan.planDigest,
  });
});

test('materializes only the exact approved lifetime and evidence', () => {
  const plan = approvalPlan();
  const binding = createPluginPackageSecretBindingFromApprovalPlan(
    plan,
    15_000,
  );
  assert.equal(binding.authority.kind, 'approved-action-execution');
  assert.equal(binding.authority.evidenceDigest, plan.approvalPlanDigest);
  assert.equal(binding.boundAtMs, 15_000);
  assert.deepEqual(binding.target, plan.bindingPlan.target);
  assert.deepEqual(binding.entries, plan.bindingPlan.entries);
  assert.throws(
    () => createPluginPackageSecretBindingFromApprovalPlan(plan, 20_001),
    InvalidPluginPackageSecretBindingApprovalPlanError,
  );
});

test('rejects digest drift, weak subjects and unbounded lifetime', () => {
  const plan = approvalPlan();
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingApprovalPlan({
        ...plan,
        approvalPlanDigest: 'f'.repeat(64),
      }),
    InvalidPluginPackageSecretBindingApprovalPlanError,
  );
  assert.throws(
    () =>
      createPluginPackageSecretBindingApprovalPlan({
        actionRef: plan.actionRef,
        bindingPlan: plan.bindingPlan,
        requestedBy: { type: 'system', id: 'executor' },
        expiresAtMs: plan.expiresAtMs,
      }),
    InvalidPluginPackageSecretBindingApprovalPlanError,
  );
  assert.throws(
    () =>
      createPluginPackageSecretBindingApprovalPlan({
        actionRef: plan.actionRef,
        bindingPlan: plan.bindingPlan,
        requestedBy: plan.requestedBy,
        expiresAtMs: plan.bindingPlan.plannedAtMs + 15 * 60 * 1000 + 1,
      }),
    InvalidPluginPackageSecretBindingApprovalPlanError,
  );
});

test('exports the approval contract only through its explicit subpath', () => {
  assert.equal(
    require('../dist').createPluginPackageSecretBindingApprovalPlan,
    undefined,
  );
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan')
      .createPluginPackageSecretBindingApprovalPlan,
    createPluginPackageSecretBindingApprovalPlan,
  );
});
