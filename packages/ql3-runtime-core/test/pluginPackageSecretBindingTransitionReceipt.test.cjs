const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackageSecretBinding,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageSecretBindingTransitionPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-plan');
const {
  createPluginPackageSecretBindingFromTransitionPlan,
  createPluginPackageSecretBindingTransitionReceipt,
  normalizePluginPackageSecretBindingTransitionReceipt,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

function manifest(secrets) {
  return {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'receipt-package',
      displayName: 'Receipt package',
      version: '2.0.0',
      description: 'Transition receipt fixture',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '8Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets,
        tools: secrets.length === 0 ? [] : ['secret.use'],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
}

const previousManifest = manifest([{ name: 'TOKEN', required: true }]);
const previousGeneration = createPluginPackageResourceGeneration({
  installationId: 'install-1',
  projectId: 'project-1',
  packageName: 'receipt-package',
  lockDigest: 'a'.repeat(64),
  generation: 1,
  previousActiveLockDigest: null,
  contentDigest: 'b'.repeat(64),
  contents: previousManifest.spec.contents,
});
const previousBinding = createPluginPackageSecretBinding({
  generation: previousGeneration,
  manifest: previousManifest,
  assignments: [
    {
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'token',
        version: 1,
      }),
    },
  ],
  authority: {
    kind: 'local-owner-confirmation',
    evidenceDigest: 'c'.repeat(64),
  },
  boundAtMs: 10,
});

function transition(nextManifest, assignments) {
  return createPluginPackageSecretBindingTransitionPlan({
    previousTarget: previousBinding.target,
    previousBinding,
    previousAttemptGeneration: 1,
    nextGeneration: createPluginPackageResourceGeneration({
      installationId: 'install-2',
      projectId: 'project-1',
      packageName: 'receipt-package',
      lockDigest: 'd'.repeat(64),
      generation: 2,
      previousActiveLockDigest: previousBinding.target.lockDigest,
      contentDigest: 'e'.repeat(64),
      contents: nextManifest.spec.contents,
    }),
    nextManifest,
    assignments,
    plannedAtMs: 20,
  });
}

test('binds an exact next binding and approval evidence into one receipt', () => {
  const plan = transition(previousManifest, [
    {
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'token',
        version: 2,
      }),
    },
  ]);
  const binding = createPluginPackageSecretBindingFromTransitionPlan(
    plan,
    'approved-action-execution',
    'f'.repeat(64),
    30,
  );
  const receipt = createPluginPackageSecretBindingTransitionReceipt({
    transitionPlan: plan,
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: 'f'.repeat(64),
    },
    binding,
    committedAtMs: 30,
  });
  assert.equal(receipt.bindingDigest, binding.bindingDigest);
  assert.equal(receipt.transitionPlan.kind, 'rotate');
  assert.deepEqual(
    normalizePluginPackageSecretBindingTransitionReceipt(receipt),
    receipt,
  );
});

test('records full revocation without inventing an empty binding', () => {
  const plan = transition(manifest([]), []);
  const binding = createPluginPackageSecretBindingFromTransitionPlan(
    plan,
    'local-owner-confirmation',
    plan.transitionDigest,
    30,
  );
  assert.equal(binding, null);
  const receipt = createPluginPackageSecretBindingTransitionReceipt({
    transitionPlan: plan,
    authority: {
      kind: 'local-owner-confirmation',
      evidenceDigest: plan.transitionDigest,
    },
    binding,
    committedAtMs: 30,
  });
  assert.equal(receipt.bindingDigest, null);
  assert.equal(receipt.transitionPlan.kind, 'revoke');
});

test('rejects missing, surplus, or authority-detached bindings', () => {
  const plan = transition(previousManifest, [
    {
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'token',
        version: 2,
      }),
    },
  ]);
  assert.throws(() =>
    createPluginPackageSecretBindingTransitionReceipt({
      transitionPlan: plan,
      authority: {
        kind: 'local-owner-confirmation',
        evidenceDigest: plan.transitionDigest,
      },
      binding: null,
      committedAtMs: 30,
    }),
  );
  const binding = createPluginPackageSecretBindingFromTransitionPlan(
    plan,
    'local-owner-confirmation',
    plan.transitionDigest,
    30,
  );
  assert.throws(() =>
    createPluginPackageSecretBindingTransitionReceipt({
      transitionPlan: plan,
      authority: {
        kind: 'approved-action-execution',
        evidenceDigest: 'f'.repeat(64),
      },
      binding,
      committedAtMs: 30,
    }),
  );

  const revoke = transition(manifest([]), []);
  assert.throws(() =>
    createPluginPackageSecretBindingTransitionReceipt({
      transitionPlan: revoke,
      authority: {
        kind: 'local-owner-confirmation',
        evidenceDigest: revoke.transitionDigest,
      },
      binding,
      committedAtMs: 30,
    }),
  );
});

test('rejects receipt shape and digest tampering', () => {
  const plan = transition(manifest([]), []);
  const receipt = createPluginPackageSecretBindingTransitionReceipt({
    transitionPlan: plan,
    authority: {
      kind: 'local-owner-confirmation',
      evidenceDigest: plan.transitionDigest,
    },
    binding: null,
    committedAtMs: 30,
  });
  assert.throws(() =>
    normalizePluginPackageSecretBindingTransitionReceipt({
      ...receipt,
      committedAtMs: 31,
    }),
  );
  assert.throws(() =>
    normalizePluginPackageSecretBindingTransitionReceipt({
      ...receipt,
      unexpected: true,
    }),
  );
});
