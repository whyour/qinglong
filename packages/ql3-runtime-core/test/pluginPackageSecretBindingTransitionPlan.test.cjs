const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackageSecretBinding,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageSecretBindingTransitionPlan,
  normalizePluginPackageSecretBindingTransitionPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-plan');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

function manifest(secrets) {
  return {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'Secret transition fixture',
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
        memory: { recommended: '32Mi' },
        disk: { install: '4Mi', working: '8Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets,
        tools: ['secret.use'],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
}

function secret(name, version) {
  return createSecretRef({ projectId: 'project-1', name, version });
}

const previousManifest = manifest([
  { name: 'OPTIONAL_TOKEN', required: false },
  { name: 'TOKEN', required: true },
]);
const previousGeneration = createPluginPackageResourceGeneration({
  installationId: 'install-1',
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
  assignments: [
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 2) },
  ],
  authority: {
    kind: 'local-owner-confirmation',
    evidenceDigest: 'c'.repeat(64),
  },
  boundAtMs: 90,
});

function nextGeneration(overrides = {}) {
  return createPluginPackageResourceGeneration({
    installationId: 'install-2',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: 'd'.repeat(64),
    generation: 2,
    previousActiveLockDigest: previousBinding.target.lockDigest,
    contentDigest: 'e'.repeat(64),
    contents: previousManifest.spec.contents,
    ...overrides,
  });
}

function transition(assignments, overrides = {}) {
  return createPluginPackageSecretBindingTransitionPlan({
    previousBinding,
    previousAttemptGeneration: overrides.previousAttemptGeneration ?? 1,
    nextGeneration: nextGeneration(overrides.generation),
    nextManifest: overrides.manifest ?? previousManifest,
    assignments,
    plannedAtMs: 100,
  });
}

test('derives an exact carry-forward for an unchanged next generation', () => {
  const value = transition([
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 2) },
  ]);
  assert.equal(value.kind, 'carry-forward');
  assert.equal(value.previousActiveLockDigest, 'a'.repeat(64));
  assert.deepEqual(
    value.changes.map(({ name, requirement, reference }) => ({
      name,
      requirement,
      reference,
    })),
    [
      {
        name: 'OPTIONAL_TOKEN',
        requirement: 'unchanged',
        reference: 'unchanged',
      },
      {
        name: 'TOKEN',
        requirement: 'unchanged',
        reference: 'unchanged',
      },
    ],
  );
  assert.deepEqual(
    normalizePluginPackageSecretBindingTransitionPlan(value),
    value,
  );
});

test('distinguishes forward rotation from rebind and version rollback', () => {
  const rotated = transition([
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 3) },
  ]);
  assert.equal(rotated.kind, 'rotate');
  assert.equal(rotated.changes[1].reference, 'rotated');

  const rebound = transition([
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('replacement-token', 1) },
  ]);
  assert.equal(rebound.kind, 'rebind');
  assert.equal(rebound.changes[1].reference, 'rebound');

  const rolledBack = transition([
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 1) },
  ]);
  assert.equal(rolledBack.kind, 'rebind');
  assert.equal(rolledBack.changes[1].reference, 'rebound');
});

test('classifies removal or unbinding as revocation', () => {
  const nextManifest = manifest([{ name: 'OPTIONAL_TOKEN', required: false }]);
  const value = transition([{ name: 'OPTIONAL_TOKEN', secretRef: null }], {
    manifest: nextManifest,
  });
  assert.equal(value.kind, 'revoke');
  assert.deepEqual(value.changes[1], {
    name: 'TOKEN',
    requirement: 'removed',
    reference: 'revoked',
    previous: { required: true, secretRef: secret('runtime-token', 2) },
    next: null,
  });
});

test('represents final requirement removal without inventing an empty binding', () => {
  const value = transition([], { manifest: manifest([]) });
  assert.equal(value.kind, 'revoke');
  assert.equal(value.nextBindingPlan, null);
  assert.equal(value.nextTarget.generation, 2);
  assert.equal(value.changes.length, 2);
});

test('treats requirement additions and optional binding as rebind', () => {
  const nextManifest = manifest([
    { name: 'EXTRA_TOKEN', required: false },
    { name: 'OPTIONAL_TOKEN', required: false },
    { name: 'TOKEN', required: true },
  ]);
  const value = transition(
    [
      { name: 'EXTRA_TOKEN', secretRef: secret('extra-token', 1) },
      { name: 'OPTIONAL_TOKEN', secretRef: null },
      { name: 'TOKEN', secretRef: secret('runtime-token', 2) },
    ],
    { manifest: nextManifest },
  );
  assert.equal(value.kind, 'rebind');
  assert.equal(value.changes[0].requirement, 'added');
  assert.equal(value.changes[0].reference, 'bound');
});

test('uses durable attempt generations and rejects skipped or detached targets', () => {
  const assignments = [
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 2) },
  ];
  assert.throws(
    () => transition(assignments, { generation: { generation: 3 } }),
    /immediate durable attempt generation/,
  );
  const retried = transition(assignments, {
    generation: { generation: 3 },
    previousAttemptGeneration: 2,
  });
  assert.equal(retried.nextTarget.generation, 3);
  assert.equal(retried.previousAttemptGeneration, 2);
  assert.throws(
    () =>
      transition(assignments, {
        generation: { previousActiveLockDigest: 'f'.repeat(64) },
      }),
    /does not name the previous active lock/,
  );
  assert.throws(
    () =>
      transition(assignments, { generation: { installationId: 'install-1' } }),
    /immediate durable attempt generation/,
  );
});

test('fails closed when classification, content or digest is rewritten', () => {
  const value = transition([
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 3) },
  ]);
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingTransitionPlan({
        ...value,
        kind: 'carry-forward',
      }),
    /classification/,
  );
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingTransitionPlan({
        ...value,
        changes: value.changes.slice(1),
      }),
    /classification/,
  );
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingTransitionPlan({
        ...value,
        transitionDigest: 'f'.repeat(64),
      }),
    /digest/,
  );
});

test('rejects extensible or accessor-bearing creation input', () => {
  const assignments = [
    { name: 'OPTIONAL_TOKEN', secretRef: null },
    { name: 'TOKEN', secretRef: secret('runtime-token', 2) },
  ];
  const input = {
    previousBinding,
    previousAttemptGeneration: 1,
    nextGeneration: nextGeneration(),
    nextManifest: previousManifest,
    assignments,
    plannedAtMs: 100,
  };
  assert.throws(
    () =>
      createPluginPackageSecretBindingTransitionPlan({ ...input, extra: true }),
    /shape is invalid/,
  );
  const accessor = { ...input };
  Object.defineProperty(accessor, 'plannedAtMs', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  assert.throws(
    () => createPluginPackageSecretBindingTransitionPlan(accessor),
    /data properties/,
  );
});

test('exports the transition contract only through its explicit subpath', () => {
  assert.equal(
    require('../dist').createPluginPackageSecretBindingTransitionPlan,
    undefined,
  );
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-secret-binding-transition-plan')
      .createPluginPackageSecretBindingTransitionPlan,
    createPluginPackageSecretBindingTransitionPlan,
  );
});
