const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');
const {
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
  materializePluginPackageResources,
} = require('../dist/plugin-package/pluginPackageResourceMaterialization');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../dist/task-definition/taskSpecSemantic');
const {
  InvalidProjectToolDefinitionSnapshotError,
  MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES,
  PROJECT_TOOL_DEFINITION_SNAPSHOT_SCHEMA,
  ProjectToolDefinitionSnapshotConflictError,
  ProjectToolDefinitionSnapshotPublicationCoordinator,
  ProjectToolDefinitionSnapshotRecoveryCoordinator,
  ProjectToolDefinitionSnapshotUnavailableError,
  createProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshotRecord,
  projectToolDefinitionActiveVectorDigest,
  projectToolDefinitionRegistry,
  projectToolDefinitionSnapshotContribution,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');

function toolDefinition(packageName, version = '1.0.0') {
  return {
    name: `${packageName}.query`,
    version,
    description: `Queries ${packageName}`,
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
  };
}

function fixture(packageName, options = {}) {
  const definitions = options.definitions ?? [toolDefinition(packageName)];
  const toolPaths = definitions.map(
    (_definition, index) => `tools/tool-${index}.json`,
  );
  const resourceBytes = Object.fromEntries(
    definitions.map((definition, index) => [
      toolPaths[index],
      Buffer.from(
        JSON.stringify({
          schema: 'qinglong/plugin-package-tool-resource@v1',
          definition,
        }),
      ),
    ]),
  );
  const descriptors = Object.entries(resourceBytes)
    .map(([path, material]) => ({
      path,
      bytes: material.byteLength,
      digest: createHash('sha256').update(material).digest('hex'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const contentDigest = pluginPackageContentTreeDigest(descriptors);
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: packageName,
      displayName: packageName,
      version: options.packageVersion ?? '1.0.0',
      description: `Package ${packageName}`,
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
        memory: { recommended: '8Mi' },
        disk: { install: '1Mi', working: '1Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: definitions.length === 0 ? [] : ['run.read'],
      },
      contents: {
        tasks: [],
        workflows: [],
        prompts: [],
        tools: toolPaths,
      },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  const action = {
    lockId: `lock-${packageName}`,
    projectId: 'project-001',
    manifest,
    plan,
    environment,
    source: {
      kind: 'oci',
      locator:
        `oci://registry.example.com/qinglong/${packageName}@sha256:` +
        'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      artifactBytes: 4096,
      contentDigest,
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: options.generation ?? 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: `request-${packageName}`,
      requestVersion: 1,
      dispatchId: `dispatch-${packageName}`,
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 1_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: `install-${packageName}`,
    projectId: lock.projectId,
    packageName: lock.packageName,
    lockDigest: lock.lockDigest,
    generation: lock.targetGeneration,
    previousActiveLockDigest: null,
    contentDigest,
    resources: lock.resources,
  });
  const registry = createBuiltInTaskSpecSemanticRegistry();
  return {
    registry,
    revision: materializePluginPackageResources({
      generation,
      lock,
      manifestBytes: Buffer.from(serializePluginPackageManifest(manifest)),
      resources: generation.resources.map((reference) => ({
        reference,
        bytes: resourceBytes[reference.path],
      })),
      taskSpecSemanticRegistry: registry,
    }),
  };
}

function contribution(value) {
  return projectToolDefinitionSnapshotContribution(
    value.revision,
    value.registry,
  );
}

function source(value) {
  const planned = contribution(value);
  return {
    installationId: planned.generation.installationId,
    packageName: planned.generation.packageName,
    generation: planned.generation.generation,
    generationDigest: planned.generation.generationDigest,
    lockDigest: planned.generation.lockDigest,
    revisionDigest: planned.revisionDigest,
  };
}

function sourceAuthority(vectors, pending = []) {
  let observation = 0;
  const pendingProjects = new Set(pending);
  return {
    pendingProjects,
    calls: [],
    async listActiveSourcePage({ projectId, limit, after }) {
      if (!after) observation += 1;
      const vector = vectors[Math.min(observation - 1, vectors.length - 1)];
      const start = after
        ? vector.findIndex((item) => item.packageName > after.packageName)
        : 0;
      const page = start < 0 ? [] : vector.slice(start, start + limit);
      const truncated = start >= 0 && start + page.length < vector.length;
      this.calls.push({
        kind: 'sources',
        projectId,
        after: after?.packageName,
        packages: page.map(({ packageName }) => packageName),
      });
      return {
        sources: page,
        truncated,
        ...(truncated
          ? { next: { packageName: page.at(-1).packageName } }
          : {}),
      };
    },
    async listPendingProjectPage({ limit, after }) {
      const projects = [...pendingProjects]
        .sort()
        .filter((projectId) => !after || projectId > after.projectId);
      const page = projects.slice(0, limit);
      const truncated = page.length < projects.length;
      return {
        projectIds: page,
        truncated,
        ...(truncated ? { next: { projectId: page.at(-1) } } : {}),
      };
    },
  };
}

function publicationHarness(values, vectors, pending = []) {
  const authority = sourceAuthority(vectors, pending);
  const revisions = new Map(
    values.map((value) => [
      value.revision.generation.generationDigest,
      value.revision,
    ]),
  );
  const records = new Map();
  const repository = {
    publications: 0,
    async findCurrent(projectId) {
      return records.get(projectId) ?? null;
    },
    async publish(snapshot) {
      this.publications += 1;
      const record = Object.freeze({ snapshot, committedAtMs: 500 });
      records.set(snapshot.projectId, record);
      authority.pendingProjects.delete(snapshot.projectId);
      return Object.freeze({ status: 'created', record });
    },
  };
  const coordinator = new ProjectToolDefinitionSnapshotPublicationCoordinator({
    source: authority,
    materializedRepository: {
      calls: [],
      async find(generationDigest) {
        this.calls.push(generationDigest);
        return revisions.get(generationDigest) ?? null;
      },
    },
    repository,
    taskSpecSemanticRegistry:
      values[0]?.registry ?? createBuiltInTaskSpecSemanticRegistry(),
    pageSize: 1,
  });
  return { authority, coordinator, records, repository, revisions };
}

test('builds one Project snapshot from the complete active Package vector', () => {
  const alpha = fixture('alpha');
  const empty = fixture('empty', { definitions: [] });
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [contribution(empty), contribution(alpha)],
  });

  assert.equal(snapshot.schema, PROJECT_TOOL_DEFINITION_SNAPSHOT_SCHEMA);
  assert.deepEqual(
    snapshot.sources.map(({ packageName }) => packageName),
    ['alpha', 'empty'],
  );
  assert.deepEqual(
    snapshot.definitions.map(({ packageName, definition }) => ({
      packageName,
      name: definition.name,
      version: definition.version,
    })),
    [{ packageName: 'alpha', name: 'alpha.query', version: '1.0.0' }],
  );
  assert.match(snapshot.activeVectorDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    projectToolDefinitionActiveVectorDigest(
      snapshot.projectId,
      snapshot.sources,
    ),
    snapshot.activeVectorDigest,
  );
  assert.match(snapshot.definitionsDigest, /^[0-9a-f]{64}$/);
  assert.match(snapshot.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(normalizeProjectToolDefinitionSnapshot(snapshot), snapshot);
  assert.deepEqual(
    normalizeProjectToolDefinitionSnapshotRecord({
      snapshot,
      committedAtMs: 500,
    }),
    { snapshot, committedAtMs: 500 },
  );
  assert.equal(
    projectToolDefinitionRegistry(snapshot).resolve('alpha.query', '1.0.0')
      .description,
    'Queries alpha',
  );
});

test('binds empty Packages and source revision changes into snapshot identity', () => {
  const alpha = fixture('alpha');
  const first = createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [contribution(alpha)],
  });
  const empty = fixture('empty', { definitions: [] });
  const withEmpty = createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [contribution(alpha), contribution(empty)],
  });
  assert.notEqual(first.activeVectorDigest, withEmpty.activeVectorDigest);
  assert.notEqual(first.snapshotDigest, withEmpty.snapshotDigest);

  const alphaV2 = fixture('alpha', {
    packageVersion: '1.0.1',
    definitions: [toolDefinition('alpha', '1.0.1')],
  });
  const next = createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [contribution(alphaV2)],
  });
  assert.notEqual(first.activeVectorDigest, next.activeVectorDigest);
  assert.notEqual(first.snapshotDigest, next.snapshotDigest);
});

test('uses the canonical Project Policy identity boundary', () => {
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'Project / 路由设备',
    contributions: [],
  });
  assert.equal(snapshot.projectId, 'Project / 路由设备');
  assert.throws(
    () =>
      createProjectToolDefinitionSnapshot({
        projectId: 'project\0invalid',
        contributions: [],
      }),
    InvalidProjectToolDefinitionSnapshotError,
  );
});

test('rejects source, ordering, digest and Tool identity drift', () => {
  const alpha = fixture('alpha');
  const empty = fixture('empty', { definitions: [] });
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-001',
    contributions: [contribution(alpha), contribution(empty)],
  });
  const mutable = JSON.parse(JSON.stringify(snapshot));

  assert.throws(
    () =>
      normalizeProjectToolDefinitionSnapshot({
        ...mutable,
        sources: [...mutable.sources].reverse(),
      }),
    /uniquely sorted/,
  );
  assert.throws(
    () =>
      normalizeProjectToolDefinitionSnapshot({
        ...mutable,
        definitions: [
          {
            ...mutable.definitions[0],
            definitionDigest: 'f'.repeat(64),
          },
        ],
      }),
    /definition digest does not match/,
  );
  assert.throws(
    () =>
      createProjectToolDefinitionSnapshot({
        projectId: 'project-001',
        contributions: [contribution(alpha), contribution(alpha)],
      }),
    /Package source is duplicated/,
  );
});

test('enforces the active Package budget before normalizing revisions', () => {
  const alpha = fixture('alpha');
  assert.throws(
    () =>
      createProjectToolDefinitionSnapshot({
        projectId: 'project-001',
        contributions: Array.from(
          { length: MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES + 1 },
          () => contribution(alpha),
        ),
      }),
    InvalidProjectToolDefinitionSnapshotError,
  );
});

test('publishes one current snapshot through paged double observation', async () => {
  const alpha = fixture('alpha');
  const empty = fixture('empty', { definitions: [] });
  const vector = [source(alpha), source(empty)];
  const harness = publicationHarness([alpha, empty], [vector, vector]);

  const result = await harness.coordinator.publishCurrent('project-001');
  assert.equal(result.status, 'created');
  assert.deepEqual(
    result.record.snapshot.sources.map(({ packageName }) => packageName),
    ['alpha', 'empty'],
  );
  assert.deepEqual(
    harness.authority.calls.map(({ packages }) => packages),
    [['alpha'], ['empty'], ['alpha'], ['empty']],
  );
  assert.equal(harness.repository.publications, 1);

  harness.authority.calls.length = 0;
  const replay = await harness.coordinator.publishCurrent('project-001');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.record, result.record);
  assert.deepEqual(harness.authority.calls, []);
});

test('fails closed when the active vector changes between observations', async () => {
  const alpha = fixture('alpha');
  const empty = fixture('empty', { definitions: [] });
  const harness = publicationHarness(
    [alpha, empty],
    [[source(alpha)], [source(alpha), source(empty)]],
  );

  await assert.rejects(
    harness.coordinator.publishCurrent('project-001'),
    ProjectToolDefinitionSnapshotConflictError,
  );
  assert.equal(harness.repository.publications, 0);
});

test('fails closed when an observed source has no exact immutable revision', async () => {
  const alpha = fixture('alpha');
  const harness = publicationHarness([], [[source(alpha)], [source(alpha)]]);

  await assert.rejects(
    harness.coordinator.publishCurrent('project-001'),
    ProjectToolDefinitionSnapshotUnavailableError,
  );
  assert.equal(harness.repository.publications, 0);
});

test('bounded snapshot recovery drains pending Projects and probes from the start', async () => {
  const harness = publicationHarness([], [[], []], ['project-a', 'project-b']);
  const recovery = new ProjectToolDefinitionSnapshotRecoveryCoordinator({
    source: harness.authority,
    publisher: harness.coordinator,
  });

  assert.deepEqual(await recovery.recover({ pageSize: 1, maxPages: 3 }), {
    pages: 2,
    scanned: 2,
    settled: 2,
    retry: 0,
    manualRequired: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.equal(harness.records.has('project-a'), true);
  assert.equal(harness.records.has('project-b'), true);
});

test('publishes snapshot planning only through its explicit subpath', () => {
  assert.equal(
    require('../dist').createProjectToolDefinitionSnapshot,
    undefined,
  );
  assert.equal(
    typeof require('../dist/tool-execution/tool-registry/projectToolDefinitionSnapshot')
      .createProjectToolDefinitionSnapshot,
    'function',
  );
  assert.equal(
    require('../dist').ProjectToolDefinitionSnapshotPublicationCoordinator,
    undefined,
  );
  assert.equal(
    typeof require('../dist/tool-execution/tool-registry/projectToolDefinitionSnapshot')
      .ProjectToolDefinitionSnapshotPublicationCoordinator,
    'function',
  );
});
