const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceGeneration');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackage');
const {
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  serializePluginPackageManifest,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/installation/pluginPackageInstall');
const {
  pluginPackageContentTreeDigest,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageBundle');
const {
  InvalidPluginPackageResourceMaterializationError,
  materializePluginPackageResources,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceMaterialization');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../../packages/ql3-runtime-core/dist/task-definition/taskSpecSemantic');

function materializedRevisionFixture(namespace, profile = 'edge') {
  const projectId = `project-${namespace}`;
  const packageName = `package-${namespace}`;
  const resourcePath = 'prompts/report.json';
  const resourceBytes = Buffer.from(
    JSON.stringify({
      schema: 'qinglong/plugin-package-prompt-resource@v1',
      id: 'report',
      name: 'Report',
      template: 'Hello {{name}}\n',
      parameters: [{ name: 'name', required: true }],
    }),
  );
  const sourceDigest = createHash('sha256').update(resourceBytes).digest('hex');
  const contentDigest = pluginPackageContentTreeDigest([
    { path: resourcePath, bytes: resourceBytes.byteLength, digest: sourceDigest },
  ]);
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: packageName,
      displayName: packageName,
      version: '1.0.0',
      description: 'One immutable semantic revision fixture',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: [profile],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '8Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: {
        tasks: [],
        workflows: [],
        prompts: [resourcePath],
        tools: [],
      },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: profile,
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  const actionInput = {
    lockId: `lock-${namespace}`,
    projectId,
    manifest,
    plan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 2048,
      contentDigest,
    },
    architecture: 'arm64',
    deploymentProfile: profile,
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: `approval-${namespace}`,
      requestVersion: 1,
      dispatchId: `dispatch-${namespace}`,
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: `install-${namespace}`,
    projectId,
    packageName,
    lockDigest: lock.lockDigest,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest,
    resources: lock.resources,
  });
  const registry = createBuiltInTaskSpecSemanticRegistry();
  const revision = materializePluginPackageResources({
    generation,
    lock,
    manifestBytes: Buffer.from(serializePluginPackageManifest(manifest)),
    resources: [
      {
        reference: generation.resources[0],
        bytes: resourceBytes,
      },
    ],
    taskSpecSemanticRegistry: registry,
  });
  return { projectId, packageName, registry, revision };
}

function registerPluginPackageMaterializedRevisionRepositoryContract(options) {
  test(`${options.name} publishes once and replays the exact revision`, async (t) => {
    const fixture = materializedRevisionFixture(
      options.namespace ?? 'materialized',
      options.profile,
    );
    const harness = await options.createRepository(t, fixture);
    t.after(() => harness.close?.());
    const first = await harness.repository.publish(fixture.revision);
    assert.equal(first.status, 'created');
    assert.deepEqual(first.revision, fixture.revision);
    const replay = await harness.repository.publish(fixture.revision);
    assert.equal(replay.status, 'existing');
    assert.deepEqual(replay.revision, fixture.revision);
    assert.deepEqual(
      await harness.repository.find(
        fixture.revision.generation.generationDigest,
      ),
      fixture.revision,
    );
  });

  test(`${options.name} returns absence and rejects invalid lookup identity`, async (t) => {
    const fixture = materializedRevisionFixture(
      `${options.namespace ?? 'materialized'}-absence`,
      options.profile,
    );
    const harness = await options.createRepository(t, fixture);
    t.after(() => harness.close?.());
    assert.equal(await harness.repository.find('f'.repeat(64)), null);
    await assert.rejects(
      harness.repository.find('../generation'),
      InvalidPluginPackageResourceMaterializationError,
    );
  });
}

module.exports = {
  materializedRevisionFixture,
  registerPluginPackageMaterializedRevisionRepositoryContract,
};
