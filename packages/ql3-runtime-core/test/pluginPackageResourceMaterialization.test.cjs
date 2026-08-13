const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');
const {
  MAX_PLUGIN_PACKAGE_MANIFEST_BYTES,
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('../dist/plugin-package/pluginPackage');
const {
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  serializePluginPackageManifest,
} = require('../dist/plugin-package/installation/pluginPackageInstall');
const {
  pluginPackageContentTreeDigest,
} = require('../dist/plugin-package/pluginPackageBundle');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../dist/task-definition/taskSpecSemantic');
const { createSecretRef } = require('../dist/secret/secretReference');
const {
  createPluginPackageSecretBinding,
} = require('../dist/plugin-package/secret-binding/binding');
const {
  InvalidPluginPackageResourceMaterializationError,
  MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES,
  PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA,
  PluginPackageResourceMaterializationConflictError,
  materializeActivePluginPackageResources,
  materializePluginPackageResources,
  normalizePluginPackageMaterializedRevision,
  pluginPackageTaskDefinitionDrafts,
  pluginPackageToolDefinitions,
} = require('../dist/plugin-package/pluginPackageResourceMaterialization');

const ARTIFACT_DIGEST = 'a'.repeat(64);
const OCI_MANIFEST_DIGEST = 'f'.repeat(64);

function resourceValues(overrides = {}) {
  return {
    'prompts/report.json': {
      schema: 'qinglong/plugin-package-prompt-resource@v1',
      id: 'report',
      name: 'Report prompt',
      description: 'Creates one bounded report',
      template: 'Hello {{name}}\n',
      parameters: [
        { name: 'name', description: 'Display name', required: true },
      ],
    },
    'tasks/collect.json': {
      schema: 'qinglong/plugin-package-task-resource@v1',
      id: 'collect',
      name: 'Collect',
      labels: { 'plugin.qinglong.io/source': 'example-monitor' },
      enabled: true,
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: {
            kind: 'argv',
            file: '/usr/bin/printf',
            args: ['ok'],
          },
          environment: [{ name: 'MODE', kind: 'public', value: 'safe' }],
          timeoutMs: 30_000,
        },
      },
    },
    'tools/query.json': {
      schema: 'qinglong/plugin-package-tool-resource@v1',
      definition: {
        name: 'example-monitor.query',
        version: '1.0.0',
        description: 'Queries one bounded report',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        effect: 'read',
        risk: 'low',
        requiredPermissions: ['run.read'],
        timeoutSeconds: 30,
      },
    },
    'workflows/daily.json': {
      schema: 'qinglong/plugin-package-workflow-resource@v1',
      id: 'daily',
      name: 'Daily report',
      enabled: true,
      steps: [{ id: 'collect', task: 'collect', needs: [] }],
    },
    ...overrides,
  };
}

function manifest(overrides = {}) {
  const value = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'One bounded example package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge', 'standalone'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '32Mi' },
        disk: { install: '8Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: ['run.read', 'system.command'],
      },
      contents: {
        tasks: ['tasks/collect.json'],
        workflows: ['workflows/daily.json'],
        prompts: ['prompts/report.json'],
        tools: ['tools/query.json'],
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

function environment() {
  return {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
}

function fixture(options = {}) {
  const resourceObjects = resourceValues(options.resourceValues);
  const packageManifest = manifest(options.manifest);
  const resourceBytes = Object.fromEntries(
    Object.entries(resourceObjects).map(([path, value]) => [
      path,
      Buffer.from(JSON.stringify(value)),
    ]),
  );
  const descriptors = Object.entries(resourceBytes)
    .map(([path, material]) => ({
      path,
      bytes: material.byteLength,
      digest: require('node:crypto')
        .createHash('sha256')
        .update(material)
        .digest('hex'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const contentDigest = pluginPackageContentTreeDigest(descriptors);
  const installEnvironment = environment();
  const plan = planPluginPackageInstall(packageManifest, installEnvironment);
  const actionInput = {
    lockId: 'lock-001',
    projectId: 'project-001',
    manifest: packageManifest,
    plan,
    environment: installEnvironment,
    source: {
      kind: 'oci',
      locator:
        `oci://registry.example.com/qinglong/example-monitor@sha256:` +
        OCI_MANIFEST_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
      artifactBytes: 4096,
      contentDigest,
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: 'approval-001',
      requestVersion: 1,
      dispatchId: 'dispatch-001',
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 1_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-001',
    projectId: lock.projectId,
    packageName: lock.packageName,
    lockDigest: lock.lockDigest,
    generation: lock.targetGeneration,
    previousActiveLockDigest: null,
    contentDigest,
    resources: lock.resources,
  });
  const entries = generation.resources.map((reference) => ({
    reference,
    bytes: resourceBytes[reference.path],
  }));
  return {
    manifest: packageManifest,
    manifestBytes: Buffer.from(serializePluginPackageManifest(packageManifest)),
    resourceBytes,
    lock,
    generation,
    entries,
    registry: createBuiltInTaskSpecSemanticRegistry(),
  };
}

test('materializes exact Task, Workflow, Prompt and Tool JSON into one immutable revision', () => {
  const value = fixture();
  const revision = materializePluginPackageResources({
    generation: value.generation,
    lock: value.lock,
    manifestBytes: value.manifestBytes,
    resources: value.entries,
    taskSpecSemanticRegistry: value.registry,
  });
  assert.equal(revision.schema, PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA);
  assert.deepEqual(
    revision.resources.map(({ kind, path }) => ({ kind, path })),
    value.generation.resources,
  );
  assert.match(revision.revisionDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(revision), true);
  assert.equal(Object.isFrozen(revision.resources), true);
  assert.deepEqual(
    normalizePluginPackageMaterializedRevision(revision, value.registry),
    revision,
  );

  const drafts = pluginPackageTaskDefinitionDrafts(revision, value.registry);
  assert.deepEqual(JSON.parse(JSON.stringify(drafts)), [
    {
      projectId: 'project-001',
      taskId: 'pkg:example-monitor:collect',
      name: 'Collect',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: {
            kind: 'argv',
            file: '/usr/bin/printf',
            args: ['ok'],
          },
          environment: [{ name: 'MODE', kind: 'public', value: 'safe' }],
          timeoutMs: 30_000,
        },
      },
      labels: { 'plugin.qinglong.io/source': 'example-monitor' },
      enabled: true,
    },
  ]);
  assert.equal(
    pluginPackageToolDefinitions(revision, value.registry)[0].name,
    'example-monitor.query',
  );
});

test('fails closed on unapproved capabilities, unresolved references and source drift', () => {
  const unapproved = fixture({
    manifest: {
      spec: {
        permissions: {
          tools: ['system.command'],
        },
      },
    },
  });
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: unapproved.generation,
        lock: unapproved.lock,
        manifestBytes: unapproved.manifestBytes,
        resources: unapproved.entries,
        taskSpecSemanticRegistry: unapproved.registry,
      }),
    /required permission is not present/,
  );

  const missingTask = fixture({
    resourceValues: {
      'workflows/daily.json': {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily report',
        enabled: true,
        steps: [{ id: 'missing', task: 'missing', needs: [] }],
      },
    },
  });
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: missingTask.generation,
        lock: missingTask.lock,
        manifestBytes: missingTask.manifestBytes,
        resources: missingTask.entries,
        taskSpecSemanticRegistry: missingTask.registry,
      }),
    /unknown package Task/,
  );

  const drift = fixture();
  const changed = drift.entries.map((entry, index) =>
    index === 0 ? { ...entry, bytes: Buffer.from('{}') } : entry,
  );
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: drift.generation,
        lock: drift.lock,
        manifestBytes: drift.manifestBytes,
        resources: changed,
        taskSpecSemanticRegistry: drift.registry,
      }),
    InvalidPluginPackageResourceMaterializationError,
  );
});

test('compiles approved Package Secret requirements into pinned Task SecretRefs', () => {
  const direct = fixture({
    manifest: {
      spec: {
        permissions: {
          secrets: [{ name: 'TOKEN', required: true }],
          tools: ['run.read', 'secret.use', 'system.command'],
        },
      },
    },
    resourceValues: {
      'tasks/collect.json': {
        schema: 'qinglong/plugin-package-task-resource@v1',
        id: 'collect',
        name: 'Collect',
        labels: {},
        enabled: true,
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/usr/bin/printf',
              args: ['ok'],
            },
            environment: [
              {
                name: 'TOKEN',
                kind: 'secret',
                secretRef: createSecretRef({
                  projectId: 'project-001',
                  name: 'TOKEN',
                }),
              },
            ],
          },
        },
      },
    },
  });
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: direct.generation,
        lock: direct.lock,
        manifestBytes: direct.manifestBytes,
        resources: direct.entries,
        taskSpecSemanticRegistry: direct.registry,
      }),
    /requires an approved binding/,
  );

  const directBinding = createPluginPackageSecretBinding({
    generation: direct.generation,
    manifest: direct.manifest,
    assignments: [
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-001',
          name: 'TOKEN',
          version: 1,
        }),
      },
    ],
    authority: {
      kind: 'local-owner-confirmation',
      evidenceDigest: 'e'.repeat(64),
    },
    boundAtMs: 200,
  });
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: direct.generation,
        lock: direct.lock,
        manifestBytes: direct.manifestBytes,
        secretBinding: directBinding,
        resources: direct.entries,
        taskSpecSemanticRegistry: direct.registry,
      }),
    /cannot contain a direct SecretRef/,
  );

  const value = fixture({
    manifest: {
      spec: {
        permissions: {
          secrets: [
            { name: 'OPTIONAL_TOKEN', required: false },
            { name: 'TOKEN', required: true },
          ],
          tools: ['run.read', 'secret.use', 'system.command'],
        },
      },
    },
    resourceValues: {
      'tasks/collect.json': {
        schema: 'qinglong/plugin-package-task-resource@v1',
        id: 'collect',
        name: 'Collect',
        labels: {},
        enabled: true,
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/usr/bin/printf',
              args: ['ok'],
            },
            environment: [
              {
                name: 'OPTIONAL_TOKEN',
                kind: 'package-secret',
                requirement: 'OPTIONAL_TOKEN',
              },
              {
                name: 'API_TOKEN',
                kind: 'package-secret',
                requirement: 'TOKEN',
              },
            ],
          },
        },
      },
    },
  });
  const secretRef = createSecretRef({
    projectId: 'project-001',
    name: 'runtime-token',
    version: 3,
  });
  const binding = createPluginPackageSecretBinding({
    generation: value.generation,
    manifest: value.manifest,
    assignments: [
      { name: 'OPTIONAL_TOKEN', secretRef: null },
      { name: 'TOKEN', secretRef },
    ],
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: 'e'.repeat(64),
    },
    boundAtMs: 200,
  });
  const revision = materializePluginPackageResources({
    generation: value.generation,
    lock: value.lock,
    manifestBytes: value.manifestBytes,
    secretBinding: binding,
    resources: value.entries,
    taskSpecSemanticRegistry: value.registry,
  });
  assert.equal(revision.secretBinding.bindingDigest, binding.bindingDigest);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(revision.resources[1].value.spec.config.environment),
    ),
    [{ kind: 'secret', name: 'API_TOKEN', secretRef }],
  );
  assert.deepEqual(
    normalizePluginPackageMaterializedRevision(revision, value.registry),
    revision,
  );
});

test('rejects cyclic Workflows, invalid UTF-8 and per-resource byte overflow', () => {
  const cyclic = fixture({
    resourceValues: {
      'workflows/daily.json': {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily report',
        enabled: true,
        steps: [
          { id: 'first', task: 'collect', needs: ['second'] },
          { id: 'second', task: 'collect', needs: ['first'] },
        ],
      },
    },
  });
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: cyclic.generation,
        lock: cyclic.lock,
        manifestBytes: cyclic.manifestBytes,
        resources: cyclic.entries,
        taskSpecSemanticRegistry: cyclic.registry,
      }),
    /contains a cycle/,
  );

  const invalidUtf8 = fixture();
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: invalidUtf8.generation,
        lock: invalidUtf8.lock,
        manifestBytes: invalidUtf8.manifestBytes,
        resources: invalidUtf8.entries.map((entry, index) =>
          index === 0 ? { ...entry, bytes: Buffer.from([0xff]) } : entry,
        ),
        taskSpecSemanticRegistry: invalidUtf8.registry,
      }),
    /not strict UTF-8/,
  );

  const overflow = fixture();
  assert.throws(
    () =>
      materializePluginPackageResources({
        generation: overflow.generation,
        lock: overflow.lock,
        manifestBytes: overflow.manifestBytes,
        resources: overflow.entries.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                bytes: Buffer.alloc(
                  MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES + 1,
                ),
              }
            : entry,
        ),
        taskSpecSemanticRegistry: overflow.registry,
      }),
    /resource bytes is invalid/,
  );
});

test('reads active bytes sequentially with explicit bounds and rejects a generation switch', async () => {
  const value = fixture();
  const reads = [];
  let observations = 0;
  const revision = await materializeActivePluginPackageResources({
    projectId: value.generation.projectId,
    packageName: value.generation.packageName,
    generationSource: {
      async findActiveResourceGeneration() {
        observations += 1;
        return value.generation;
      },
    },
    lockSource: {
      async findLock(lockDigest) {
        assert.equal(lockDigest, value.lock.lockDigest);
        return value.lock;
      },
    },
    byteSource: {
      async open(generation) {
        assert.equal(
          generation.generationDigest,
          value.generation.generationDigest,
        );
        return {
          async read(path, maximumBytes) {
            reads.push({ path, maximumBytes });
            return path === 'package.json'
              ? value.manifestBytes
              : value.resourceBytes[path];
          },
          async close() {},
        };
      },
    },
    taskSpecSemanticRegistry: value.registry,
  });
  assert.equal(revision.revisionDigest.length, 64);
  assert.equal(observations, 2);
  assert.deepEqual(reads, [
    { path: 'package.json', maximumBytes: MAX_PLUGIN_PACKAGE_MANIFEST_BYTES },
    ...value.generation.resources.map(({ path }) => ({
      path,
      maximumBytes: MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES,
    })),
  ]);

  const changed = createPluginPackageResourceGenerationFromReferences({
    installationId: value.generation.installationId,
    projectId: value.generation.projectId,
    packageName: value.generation.packageName,
    lockDigest: value.generation.lockDigest,
    generation: 2,
    previousActiveLockDigest: value.generation.lockDigest,
    contentDigest: value.generation.contentDigest,
    resources: value.generation.resources,
  });
  await assert.rejects(
    materializeActivePluginPackageResources({
      projectId: value.generation.projectId,
      packageName: value.generation.packageName,
      generationSource: {
        calls: 0,
        async findActiveResourceGeneration() {
          this.calls += 1;
          return this.calls === 1 ? value.generation : changed;
        },
      },
      lockSource: {
        async findLock() {
          return value.lock;
        },
      },
      byteSource: {
        async open() {
          return {
            async read(path) {
              return path === 'package.json'
                ? value.manifestBytes
                : value.resourceBytes[path];
            },
            async close() {},
          };
        },
      },
      taskSpecSemanticRegistry: value.registry,
    }),
    PluginPackageResourceMaterializationConflictError,
  );
});

test('publishes materialization only through the explicit runtime-core subpath', () => {
  assert.equal(require('../dist').materializePluginPackageResources, undefined);
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-resource-materialization')
      .materializePluginPackageResources,
    materializePluginPackageResources,
  );
});
