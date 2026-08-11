const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackageInstallMutationConflictError,
  PluginPackageInstallTransitionConflictError,
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/installation/pluginPackageInstall');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackage');

const ARTIFACT_DIGEST = 'a'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);

function manifest(packageName) {
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: packageName,
      displayName: packageName,
      version: '1.2.0',
      description: 'One bounded package',
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
        disk: { install: '4Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: {
        tasks: [],
        workflows: [],
        prompts: [],
        tools: [],
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

function fixture(namespace, overrides = {}) {
  const packageName = overrides.packageName ?? `${namespace}-package`;
  const packageManifest = manifest(packageName);
  const installEnvironment = environment();
  const plan = planPluginPackageInstall(packageManifest, installEnvironment);
  const source = {
    kind: 'offline',
    locator: `offline:sha256:${ARTIFACT_DIGEST}`,
    artifactDigest: ARTIFACT_DIGEST,
    artifactBytes: 2048,
    contentDigest: CONTENT_DIGEST,
  };
  const lockId = overrides.lockId ?? `lock-${namespace}`;
  const actionInput = {
    lockId,
    projectId: 'default',
    manifest: packageManifest,
    plan,
    environment: installEnvironment,
    source,
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: `approval-${lockId}`,
      requestVersion: 1,
      dispatchId: `dispatch-${lockId}`,
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const install = createPluginPackageInstall(lock, {
    installationId: overrides.installationId ?? `install-${namespace}`,
    mutationId: overrides.mutationId ?? `mutation-create-${namespace}`,
    occurredAtMs: overrides.occurredAtMs ?? 201,
  });
  return { lock, install };
}

function stage(lock, install, overrides = {}) {
  return transitionPluginPackageInstall(lock, install, {
    type: 'stage_completed',
    mutationId:
      overrides.mutationId ?? `mutation-stage-${install.installationId}`,
    occurredAtMs: overrides.occurredAtMs ?? install.updatedAtMs + 1,
    stageRef: `stage:${lock.lockDigest}`,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'e'.repeat(64),
  });
}

function registerPluginPackageInstallRepositoryContract({
  name,
  createRepository,
}) {
  let sequence = 0;

  function nextNamespace(suffix) {
    sequence += 1;
    return `ql3-${process.pid.toString(36)}-${Date.now().toString(
      36,
    )}-${sequence.toString(36)}-${suffix}`;
  }

  async function setup(t, suffix) {
    const namespace = nextNamespace(suffix);
    const harness = await createRepository({ namespace });
    if (harness.close) t.after(() => harness.close());
    return { namespace, repository: harness.repository };
  }

  test(`${name}: creates, finds, and exactly replays one durable head`, async (t) => {
    const { namespace, repository } = await setup(t, 'create');
    const value = fixture(namespace);
    const command = pluginPackageInstallCreate(value.lock, value.install, null);
    const created = await repository.create(command);
    assert.equal(created.status, 'created');
    assert.deepEqual(
      await repository.find('default', value.install.packageName),
      value.install,
    );
    assert.deepEqual(
      await repository.findLock(value.lock.lockDigest),
      value.lock,
    );
    assert.equal(await repository.findLock('f'.repeat(64)), null);
    const replay = await repository.create(command);
    assert.equal(replay.status, 'existing');
    assert.deepEqual(replay.record, value.install);
  });

  test(`${name}: rejects mutation reuse with different locked facts`, async (t) => {
    const { namespace, repository } = await setup(t, 'mutation');
    const value = fixture(namespace);
    await repository.create(
      pluginPackageInstallCreate(value.lock, value.install, null),
    );
    const drift = fixture(namespace, {
      lockId: `lock-${namespace}-drift`,
      installationId: value.install.installationId,
      mutationId: value.install.lastMutationId,
    });
    await assert.rejects(
      repository.create(
        pluginPackageInstallCreate(drift.lock, drift.install, null),
      ),
      PluginPackageInstallMutationConflictError,
    );
  });

  test(`${name}: commits exact CAS transitions and rejects stale state`, async (t) => {
    const { namespace, repository } = await setup(t, 'cas');
    const value = fixture(namespace);
    await repository.create(
      pluginPackageInstallCreate(value.lock, value.install, null),
    );
    const staged = stage(value.lock, value.install);
    const command = pluginPackageInstallCommit(value.install, staged);
    const committed = await repository.commit(command);
    assert.equal(committed.status, 'committed');
    assert.deepEqual(
      await repository.find('default', value.install.packageName),
      staged,
    );
    assert.equal((await repository.commit(command)).status, 'existing');

    const competing = stage(value.lock, value.install, {
      mutationId: `mutation-competing-${namespace}`,
    });
    await assert.rejects(
      repository.commit(pluginPackageInstallCommit(value.install, competing)),
      PluginPackageInstallTransitionConflictError,
    );
  });

  test(`${name}: replays an old mutation to the current advanced record`, async (t) => {
    const { namespace, repository } = await setup(t, 'advance');
    const value = fixture(namespace);
    const create = pluginPackageInstallCreate(value.lock, value.install, null);
    await repository.create(create);
    const staged = stage(value.lock, value.install);
    await repository.commit(pluginPackageInstallCommit(value.install, staged));
    const activating = transitionPluginPackageInstall(value.lock, staged, {
      type: 'activation_started',
      mutationId: `mutation-activate-${namespace}`,
      occurredAtMs: 203,
    });
    await repository.commit(pluginPackageInstallCommit(staged, activating));

    const replay = await repository.create(create);
    assert.equal(replay.status, 'existing');
    assert.deepEqual(replay.record, activating);
  });

  test(`${name}: replaces only an exact terminal head`, async (t) => {
    const { namespace, repository } = await setup(t, 'replace');
    const first = fixture(namespace);
    await repository.create(
      pluginPackageInstallCreate(first.lock, first.install, null),
    );
    const failed = transitionPluginPackageInstall(first.lock, first.install, {
      type: 'failed',
      mutationId: `mutation-fail-${namespace}`,
      occurredAtMs: 202,
      reason: 'stage_failed',
    });
    await repository.commit(pluginPackageInstallCommit(first.install, failed));

    const retry = fixture(namespace, {
      lockId: `lock-${namespace}-retry`,
      installationId: `install-${namespace}-retry`,
      mutationId: `mutation-${namespace}-retry`,
      occurredAtMs: 203,
    });
    await repository.create(
      pluginPackageInstallCreate(retry.lock, retry.install, failed),
    );
    assert.deepEqual(
      await repository.find('default', first.install.packageName),
      retry.install,
    );

    const stale = fixture(namespace, {
      lockId: `lock-${namespace}-stale`,
      installationId: `install-${namespace}-stale`,
      mutationId: `mutation-${namespace}-stale`,
      occurredAtMs: 204,
    });
    await assert.rejects(
      repository.create(
        pluginPackageInstallCreate(stale.lock, stale.install, failed),
      ),
      PluginPackageInstallTransitionConflictError,
    );
  });

  test(`${name}: paginates only current recoverable heads with a stable cursor`, async (t) => {
    const { namespace, repository } = await setup(t, 'recovery');
    const alpha = fixture(namespace, {
      packageName: `${namespace}-alpha`,
      lockId: `lock-${namespace}-alpha`,
      installationId: `install-${namespace}-alpha`,
      mutationId: `mutation-${namespace}-alpha`,
    });
    const beta = fixture(namespace, {
      packageName: `${namespace}-beta`,
      lockId: `lock-${namespace}-beta`,
      installationId: `install-${namespace}-beta`,
      mutationId: `mutation-${namespace}-beta`,
    });
    await repository.create(
      pluginPackageInstallCreate(alpha.lock, alpha.install, null),
    );
    await repository.create(
      pluginPackageInstallCreate(beta.lock, beta.install, null),
    );
    const beforeNamespace = {
      packageName: namespace,
      installationId: `cursor-${namespace}`,
    };
    const first = await repository.listRecoveryPage({
      limit: 1,
      after: beforeNamespace,
    });
    assert.deepEqual(first.records, [alpha.install]);
    assert.equal(first.truncated, true);
    assert.deepEqual(first.next, {
      packageName: alpha.install.packageName,
      installationId: alpha.install.installationId,
    });
    const second = await repository.listRecoveryPage({
      limit: 1,
      after: first.next,
    });
    assert.deepEqual(second.records, [beta.install]);

    const failed = transitionPluginPackageInstall(alpha.lock, alpha.install, {
      type: 'failed',
      mutationId: `mutation-${namespace}-alpha-fail`,
      occurredAtMs: 202,
      reason: 'source_unavailable',
    });
    await repository.commit(pluginPackageInstallCommit(alpha.install, failed));
    const recovery = await repository.listRecoveryPage({
      limit: 64,
      after: beforeNamespace,
    });
    assert.deepEqual(
      recovery.records.filter((record) =>
        record.packageName.startsWith(namespace),
      ),
      [beta.install],
    );
  });

  test(`${name}: lists every current head for one project with a stable cursor`, async (t) => {
    const { namespace, repository } = await setup(t, 'inventory');
    const alpha = fixture(namespace, {
      packageName: `${namespace}-alpha`,
      lockId: `lock-${namespace}-inventory-alpha`,
      installationId: `install-${namespace}-inventory-alpha`,
      mutationId: `mutation-${namespace}-inventory-alpha`,
    });
    const beta = fixture(namespace, {
      packageName: `${namespace}-beta`,
      lockId: `lock-${namespace}-inventory-beta`,
      installationId: `install-${namespace}-inventory-beta`,
      mutationId: `mutation-${namespace}-inventory-beta`,
    });
    await repository.create(
      pluginPackageInstallCreate(alpha.lock, alpha.install, null),
    );
    await repository.create(
      pluginPackageInstallCreate(beta.lock, beta.install, null),
    );
    const failed = transitionPluginPackageInstall(alpha.lock, alpha.install, {
      type: 'failed',
      mutationId: `mutation-${namespace}-inventory-alpha-failed`,
      occurredAtMs: 202,
      reason: 'source_unavailable',
    });
    await repository.commit(pluginPackageInstallCommit(alpha.install, failed));

    const first = await repository.listCurrentPage({
      projectId: 'default',
      limit: 1,
      after: { packageName: namespace },
    });
    assert.deepEqual(first.items, [{ record: failed, quarantine: null }]);
    assert.equal(first.truncated, true);
    assert.deepEqual(first.next, { packageName: alpha.install.packageName });
    const second = await repository.listCurrentPage({
      projectId: 'default',
      limit: 1,
      after: first.next,
    });
    assert.deepEqual(second.items, [
      { record: beta.install, quarantine: null },
    ]);
  });
}

module.exports = {
  fixture,
  registerPluginPackageInstallRepositoryContract,
};
