const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackageSecretBindingFromPlan,
  createPluginPackageSecretBindingPlan,
  normalizePluginPackageSecretBindingPlan,
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
    description: 'Secret binding plan fixture',
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
      secrets: [
        { name: 'OPTIONAL_TOKEN', required: false },
        { name: 'TOKEN', required: true },
      ],
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

function plan() {
  return createPluginPackageSecretBindingPlan({
    generation,
    manifest,
    assignments: [
      { name: 'OPTIONAL_TOKEN', secretRef: null },
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-1',
          name: 'runtime-token',
          version: 2,
        }),
      },
    ],
    plannedAtMs: 100,
  });
}

test('creates one canonical content-free Secret binding plan', () => {
  const value = plan();
  assert.match(value.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(value.plannedAtMs, 100);
  assert.deepEqual(normalizePluginPackageSecretBindingPlan(value), value);
  assert.equal(JSON.stringify(value).includes('secret-value'), false);
  assert.equal(Object.isFrozen(value), true);
});

test('rejects target, entry, time and digest drift', () => {
  const value = plan();
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingPlan({ ...value, plannedAtMs: -1 }),
    /plannedAtMs is invalid/,
  );
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingPlan({
        ...value,
        target: { ...value.target, projectId: 'project-2' },
      }),
    /crosses Project boundary|plan digest/,
  );
  assert.throws(
    () => normalizePluginPackageSecretBindingPlan({ ...value, extra: true }),
    /shape is invalid/,
  );
  assert.throws(
    () =>
      normalizePluginPackageSecretBindingPlan({
        ...value,
        planDigest: 'c'.repeat(64),
      }),
    /plan digest does not match/,
  );
});

test('creates Local and Cluster authority bindings from the same plan', () => {
  const value = plan();
  const local = createPluginPackageSecretBindingFromPlan(
    value,
    'local-owner-confirmation',
    110,
  );
  const cluster = createPluginPackageSecretBindingFromPlan(
    value,
    'approved-action-execution',
    120,
  );
  assert.equal(local.authority.evidenceDigest, value.planDigest);
  assert.equal(cluster.authority.evidenceDigest, value.planDigest);
  assert.equal(local.boundAtMs, 110);
  assert.equal(cluster.boundAtMs, 120);
  assert.notEqual(local.bindingDigest, cluster.bindingDigest);
});

test('exports the plan contract only through its explicit subpath', () => {
  assert.equal(
    require('../dist').createPluginPackageSecretBindingPlan,
    undefined,
  );
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-secret-binding-plan')
      .createPluginPackageSecretBindingPlan,
    createPluginPackageSecretBindingPlan,
  );
});
