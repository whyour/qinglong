const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackageSecretBindingError,
  PLUGIN_PACKAGE_SECRET_BINDING_SCHEMA,
  assertPluginPackageSecretBindingMatches,
  createPluginPackageSecretBinding,
  normalizePluginPackageSecretBinding,
} = require('../dist/plugin-package/pluginPackageSecretBinding');
const {
  createPluginPackageResourceGeneration,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');
const { createSecretRef } = require('../dist/secret/secretReference');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
} = require('../dist/plugin-package/pluginPackage');

const LOCK_DIGEST = 'a'.repeat(64);
const EVIDENCE_DIGEST = 'b'.repeat(64);

function manifest(
  secretRequirements = [
    { name: 'OPTIONAL_TOKEN', required: false },
    { name: 'REQUIRED_TOKEN', required: true },
  ],
) {
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'Tests durable Secret binding',
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
        secrets: secretRequirements,
        tools: [],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
}

function generation(projectId = 'project-1') {
  return createPluginPackageResourceGeneration({
    installationId: 'install-1',
    projectId,
    packageName: 'example-monitor',
    lockDigest: LOCK_DIGEST,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'c'.repeat(64),
    contents: { tasks: [], workflows: [], prompts: [], tools: [] },
  });
}

function versionedRef(projectId, name, version = 3) {
  return createSecretRef({ projectId, name, version });
}

function binding(overrides = {}) {
  return createPluginPackageSecretBinding({
    generation: generation(),
    manifest: manifest(),
    assignments: [
      { name: 'OPTIONAL_TOKEN', secretRef: null },
      {
        name: 'REQUIRED_TOKEN',
        secretRef: versionedRef('project-1', 'runtime-token'),
      },
    ],
    authority: {
      kind: 'local-owner-confirmation',
      evidenceDigest: EVIDENCE_DIGEST,
    },
    boundAtMs: 1_700_000_000_000,
    ...overrides,
  });
}

test('creates one canonical generation-bound Secret binding without plaintext', () => {
  const value = binding();
  assert.equal(value.schema, PLUGIN_PACKAGE_SECRET_BINDING_SCHEMA);
  assert.deepEqual(value.entries, [
    { name: 'OPTIONAL_TOKEN', required: false, secretRef: null },
    {
      name: 'REQUIRED_TOKEN',
      required: true,
      secretRef: versionedRef('project-1', 'runtime-token'),
    },
  ]);
  assert.match(value.bindingDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(value).includes('secret-value'), false);
  assert.deepEqual(normalizePluginPackageSecretBinding(value), value);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.entries), true);
});

test('requires assignments to exactly cover the Manifest contract', () => {
  assert.throws(
    () => binding({ assignments: [] }),
    /exactly match Manifest requirements/,
  );
  assert.throws(
    () =>
      binding({
        assignments: [
          { name: 'OPTIONAL_TOKEN', secretRef: null },
          { name: 'UNDECLARED_TOKEN', secretRef: null },
        ],
      }),
    InvalidPluginPackageSecretBindingError,
  );
  assert.throws(
    () =>
      binding({
        assignments: [
          { name: 'OPTIONAL_TOKEN', secretRef: null },
          { name: 'REQUIRED_TOKEN', secretRef: null },
        ],
      }),
    /required Secret REQUIRED_TOKEN is unbound/,
  );
});

test('rejects floating and cross-Project Secret references', () => {
  assert.throws(
    () =>
      binding({
        assignments: [
          { name: 'OPTIONAL_TOKEN', secretRef: null },
          {
            name: 'REQUIRED_TOKEN',
            secretRef: createSecretRef({
              projectId: 'project-1',
              name: 'runtime-token',
            }),
          },
        ],
      }),
    /must pin an explicit version/,
  );
  assert.throws(
    () =>
      binding({
        assignments: [
          { name: 'OPTIONAL_TOKEN', secretRef: null },
          {
            name: 'REQUIRED_TOKEN',
            secretRef: versionedRef('project-2', 'runtime-token'),
          },
        ],
      }),
    /crosses Project boundary/,
  );
});

test('fails closed on authority, target, order and digest drift', () => {
  assert.throws(
    () =>
      binding({
        authority: { kind: 'operator', evidenceDigest: EVIDENCE_DIGEST },
      }),
    /authority kind is invalid/,
  );
  const value = binding();
  assert.throws(
    () =>
      normalizePluginPackageSecretBinding({
        ...value,
        entries: [...value.entries].reverse(),
      }),
    /canonical order/,
  );
  assert.throws(
    () =>
      normalizePluginPackageSecretBinding({
        ...value,
        target: { ...value.target, generationDigest: 'd'.repeat(64) },
      }),
    /binding digest does not match/,
  );
  assert.throws(
    () => normalizePluginPackageSecretBinding({ ...value, extra: true }),
    /binding shape is invalid/,
  );
});

test('revalidates durable binding against the complete generation and Manifest', () => {
  const value = binding();
  assert.deepEqual(
    assertPluginPackageSecretBindingMatches(value, generation(), manifest()),
    value,
  );
  assert.throws(
    () =>
      assertPluginPackageSecretBindingMatches(
        value,
        generation('project-2'),
        manifest(),
      ),
    /target does not match/,
  );
  assert.throws(
    () =>
      assertPluginPackageSecretBindingMatches(
        value,
        generation(),
        manifest([{ name: 'REQUIRED_TOKEN', required: true }]),
      ),
    /target does not match|entries do not exactly match/,
  );
});

test('rejects a binding when the Package declares no Secret requirement', () => {
  assert.throws(
    () =>
      binding({
        manifest: manifest([]),
        assignments: [],
      }),
    /does not declare Secret requirements/,
  );
});

test('exports Secret binding only through its explicit subpath', () => {
  assert.equal(require('../dist').createPluginPackageSecretBinding, undefined);
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-secret-binding')
      .createPluginPackageSecretBinding,
    createPluginPackageSecretBinding,
  );
});
