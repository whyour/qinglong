'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackageSecretBinding,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  createPluginPackageSecretBindingTransitionPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-plan');
const {
  createPluginPackageSecretBindingTransitionApprovalPlan,
  normalizePluginPackageSecretBindingTransitionApprovalPlan,
  pluginPackageSecretBindingTransitionApprovedAction,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan');

function manifest(version = '2.0.0') {
  return {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version,
      description: 'transition approval fixture',
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
}

function transition() {
  const previousManifest = manifest('1.0.0');
  const previousGeneration = createPluginPackageResourceGeneration({
    installationId: 'install-v1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    contents: previousManifest.spec.contents,
  });
  const previousBinding = createPluginPackageSecretBinding({
    generation: previousGeneration,
    manifest: previousManifest,
    assignments: [{
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'runtime-token',
        version: 1,
      }),
    }],
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: 'c'.repeat(64),
    },
    boundAtMs: 80,
  });
  return createPluginPackageSecretBindingTransitionPlan({
    previousTarget: previousBinding.target,
    previousBinding,
    previousAttemptGeneration: 1,
    nextGeneration: createPluginPackageResourceGeneration({
      installationId: 'install-v2',
      projectId: 'project-1',
      packageName: 'example-monitor',
      lockDigest: 'd'.repeat(64),
      generation: 2,
      previousActiveLockDigest: 'a'.repeat(64),
      contentDigest: 'e'.repeat(64),
      contents: manifest().spec.contents,
    }),
    nextManifest: manifest(),
    assignments: [{
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'runtime-token',
        version: 2,
      }),
    }],
    plannedAtMs: 100,
  });
}

test('binds one transition to an immutable separation-of-duty action', () => {
  const plan = createPluginPackageSecretBindingTransitionApprovalPlan({
    actionRef: 'secret-transition:example-monitor-v2',
    transitionPlan: transition(),
    requestedBy: { type: 'user', id: 'cluster-owner' },
    plannedAtMs: 100,
    expiresAtMs: 1_000,
  });
  assert.deepEqual(
    normalizePluginPackageSecretBindingTransitionApprovalPlan(plan),
    plan,
  );
  assert.deepEqual(pluginPackageSecretBindingTransitionApprovedAction(plan), {
    permission: 'secret.manage',
    actionType: 'plugin_package.secret_binding.transition',
    actionRef: plan.actionRef,
    actionDigest: plan.approvalPlanDigest,
    previewDigest: plan.transitionPlan.transitionDigest,
  });
});

test('rejects digest, lifetime and requester drift', () => {
  const plan = createPluginPackageSecretBindingTransitionApprovalPlan({
    actionRef: 'secret-transition:example-monitor-v2',
    transitionPlan: transition(),
    requestedBy: { type: 'user', id: 'cluster-owner' },
    plannedAtMs: 100,
    expiresAtMs: 1_000,
  });
  assert.throws(() =>
    normalizePluginPackageSecretBindingTransitionApprovalPlan({
      ...plan,
      approvalPlanDigest: '9'.repeat(64),
    }),
  );
  assert.throws(() =>
    createPluginPackageSecretBindingTransitionApprovalPlan({
      actionRef: plan.actionRef,
      transitionPlan: plan.transitionPlan,
      requestedBy: { type: 'system', id: 'cluster-control' },
      plannedAtMs: 100,
      expiresAtMs: 1_000,
    }),
  );
});
