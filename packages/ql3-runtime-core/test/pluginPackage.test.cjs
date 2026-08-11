const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const {
  InvalidPluginPackageInstallEnvironmentError,
  InvalidPluginPackageManifestError,
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  normalizePluginPackageManifest,
  planPluginPackageInstall,
} = require('../dist/plugin-package/pluginPackage');

function manifest(overrides = {}) {
  const value = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'Collects a bounded report',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64', 'amd64'],
        deploymentProfiles: ['standalone', 'edge'],
      },
      runtimes: [{ name: 'python', version: '>=3.10.0 <4.0.0' }],
      resources: {
        memory: { recommended: '128Mi' },
        disk: { install: '20Mi', working: '100Mi' },
      },
      permissions: {
        network: { allowedHosts: ['api.example.com'] },
        secrets: [{ name: 'EXAMPLE_TOKEN', required: true }],
        tools: ['notification.send'],
      },
      contents: {
        tasks: ['tasks/collect.yaml'],
        workflows: ['workflows/daily-report.yaml'],
        prompts: ['prompts/analyze-error.md'],
        tools: ['tools/query-data.yaml'],
      },
    },
  };
  return {
    ...value,
    ...overrides,
    metadata: { ...value.metadata, ...overrides.metadata },
    spec: {
      ...value.spec,
      ...overrides.spec,
      compatibility: {
        ...value.spec.compatibility,
        ...overrides.spec?.compatibility,
      },
      resources: {
        ...value.spec.resources,
        ...overrides.spec?.resources,
        memory: {
          ...value.spec.resources.memory,
          ...overrides.spec?.resources?.memory,
        },
        disk: {
          ...value.spec.resources.disk,
          ...overrides.spec?.resources?.disk,
        },
      },
      permissions: {
        ...value.spec.permissions,
        ...overrides.spec?.permissions,
        network: {
          ...value.spec.permissions.network,
          ...overrides.spec?.permissions?.network,
        },
      },
      contents: {
        ...value.spec.contents,
        ...overrides.spec?.contents,
      },
    },
  };
}

function environment(overrides = {}) {
  return {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [{ name: 'python', version: '3.12.4' }],
    availableMemoryBytes: 256 * 1024 * 1024,
    availableDiskBytes: 512 * 1024 * 1024,
    ...overrides,
  };
}

test('normalizes and deeply freezes one bounded Package manifest', () => {
  const normalized = normalizePluginPackageManifest(manifest());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.spec.permissions.secrets), true);
  assert.deepEqual(normalized.spec.compatibility.architectures, [
    'amd64',
    'arm64',
  ]);
  assert.deepEqual(normalized.spec.compatibility.deploymentProfiles, [
    'edge',
    'standalone',
  ]);
  assert.deepEqual(normalized.spec.contents, {
    tasks: ['tasks/collect.yaml'],
    workflows: ['workflows/daily-report.yaml'],
    prompts: ['prompts/analyze-error.md'],
    tools: ['tools/query-data.yaml'],
  });
});

test('keeps the reviewed Node 24 candidate architecture vocabulary', () => {
  const normalized = normalizePluginPackageManifest(
    manifest({
      spec: {
        compatibility: {
          architectures: ['s390x', 'ppc64le', 'arm/v7', 'arm64', 'amd64'],
        },
      },
    }),
  );
  assert.deepEqual(normalized.spec.compatibility.architectures, [
    'amd64',
    'arm/v7',
    'arm64',
    'ppc64le',
    's390x',
  ]);
});

test('publishes the contract through the root and plugin-package subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/plugin-package');
  assert.equal(
    root.normalizePluginPackageManifest,
    normalizePluginPackageManifest,
  );
  assert.equal(subpath.planPluginPackageInstall, planPluginPackageInstall);
});

test('rejects unknown fields, unsupported kinds and non-canonical versions', () => {
  assert.throws(
    () => normalizePluginPackageManifest({ ...manifest(), extra: true }),
    InvalidPluginPackageManifestError,
  );
  assert.throws(
    () => normalizePluginPackageManifest(manifest({ kind: 'Extension' })),
    /apiVersion or kind is unsupported/,
  );
  assert.throws(
    () =>
      normalizePluginPackageManifest(
        manifest({ metadata: { version: 'v1.2.0' } }),
      ),
    /metadata version is invalid/,
  );
});

test('rejects traversal, wildcard hosts, duplicate authority and core migrations', () => {
  const invalid = [
    manifest({ spec: { contents: { tasks: ['tasks/../migration.sql'] } } }),
    manifest({
      spec: {
        contents: {
          tasks: ['migrations/0001.sql'],
        },
      },
    }),
    manifest({
      spec: {
        permissions: {
          network: { allowedHosts: ['*.example.com'] },
        },
      },
    }),
    manifest({
      spec: {
        permissions: {
          secrets: [
            { name: 'TOKEN', required: true },
            { name: 'TOKEN', required: false },
          ],
        },
      },
    }),
    manifest({
      spec: {
        runtimes: [
          { name: 'python', version: '>=3.10.0' },
          { name: 'python', version: '>=3.11.0' },
        ],
      },
    }),
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizePluginPackageManifest(value),
      InvalidPluginPackageManifestError,
    );
  }
});

test('rejects unreviewed profiles, architectures, permissions and resource units', () => {
  const invalid = [
    manifest({
      spec: { compatibility: { architectures: ['386'] } },
    }),
    manifest({
      spec: { compatibility: { deploymentProfiles: ['control'] } },
    }),
    manifest({
      spec: { permissions: { tools: ['database.superuser'] } },
    }),
    manifest({
      spec: { resources: { memory: { recommended: '128MB' } } },
    }),
    manifest({
      spec: { resources: { disk: { working: '2048Gi' } } },
    }),
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizePluginPackageManifest(value),
      InvalidPluginPackageManifestError,
    );
  }
});

test('plans a compatible install with explicit resources and permissions', () => {
  const plan = planPluginPackageInstall(manifest(), environment());
  assert.deepEqual(plan, {
    package: {
      name: 'example-monitor',
      toVersion: '1.2.0',
    },
    operation: 'install',
    compatible: true,
    risk: 'medium',
    approvalRequired: true,
    permissionReapprovalRequired: true,
    permissionDelta: {
      added: [
        'network:api.example.com',
        'secret:EXAMPLE_TOKEN:required',
        'tool:notification.send',
      ],
      removed: [],
    },
    resources: {
      memoryRecommendedBytes: 128 * 1024 * 1024,
      diskInstallBytes: 20 * 1024 * 1024,
      diskWorkingBytes: 100 * 1024 * 1024,
    },
    contents: {
      tasks: 1,
      workflows: 1,
      prompts: 1,
      tools: 1,
    },
    findings: [],
  });
  assert.equal(Object.isFrozen(plan.permissionDelta.added), true);
});

test('fails compatibility for runtime, profile, version and disk without hiding warnings', () => {
  const plan = planPluginPackageInstall(
    manifest(),
    environment({
      qinglongVersion: '4.0.0',
      architecture: 's390x',
      deploymentProfile: 'worker',
      runtimes: [{ name: 'python', version: '2.7.18' }],
      availableMemoryBytes: 64 * 1024 * 1024,
      availableDiskBytes: 64 * 1024 * 1024,
    }),
  );
  assert.equal(plan.compatible, false);
  assert.deepEqual(
    plan.findings.map(({ code, severity }) => [code, severity]),
    [
      ['architecture_unsupported', 'error'],
      ['deployment_profile_unsupported', 'error'],
      ['disk_insufficient', 'error'],
      ['qinglong_version_unsupported', 'error'],
      ['runtime_version_unsupported', 'error'],
      ['memory_below_recommendation', 'warning'],
    ],
  );
});

test('detects upgrade permission expansion and permits reviewed rollback planning', () => {
  const previous = manifest({
    metadata: { version: '1.1.0' },
    spec: {
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
    },
  });
  const upgrade = planPluginPackageInstall(manifest(), environment(), previous);
  assert.equal(upgrade.operation, 'upgrade');
  assert.equal(upgrade.permissionReapprovalRequired, true);
  assert.deepEqual(upgrade.package, {
    name: 'example-monitor',
    fromVersion: '1.1.0',
    toVersion: '1.2.0',
  });

  const rollback = planPluginPackageInstall(
    previous,
    environment(),
    manifest(),
  );
  assert.equal(rollback.operation, 'rollback');
  assert.equal(rollback.permissionReapprovalRequired, false);
  assert.deepEqual(rollback.permissionDelta.added, []);
  assert.equal(rollback.permissionDelta.removed.length, 3);
});

test('rejects ambiguous install environments and cross-package upgrades', () => {
  assert.throws(
    () =>
      planPluginPackageInstall(manifest(), {
        ...environment(),
        extra: true,
      }),
    InvalidPluginPackageInstallEnvironmentError,
  );
  assert.throws(
    () =>
      planPluginPackageInstall(
        manifest(),
        environment(),
        manifest({ metadata: { name: 'different-package' } }),
      ),
    /package names differ/,
  );
});

test('keeps the core contract free of filesystem, process, timer and network authority', () => {
  const source = readFileSync(
    join(__dirname, '../src/plugin-package/pluginPackage.ts'),
    'utf8',
  );
  for (const authority of [
    "from 'node:child_process'",
    "from 'node:fs'",
    "from 'node:http'",
    "from 'node:https'",
    'setInterval(',
    'setTimeout(',
  ]) {
    assert.equal(source.includes(authority), false, authority);
  }
});
