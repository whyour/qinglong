const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('../dist/plugin-package/pluginPackage');
const {
  PluginPackageInstallTransitionConflictError,
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('../dist/plugin-package/installation/pluginPackageInstall');
const {
  PluginPackageActivationConflictError,
  PluginPackageActivationCoordinator,
  PluginPackageActivationUnavailableError,
  createPluginPackageActivationIntent,
  normalizePluginPackageActivationIntent,
} = require('../dist/plugin-package/installation/pluginPackageActivation');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');

const ARTIFACT_DIGEST = 'a'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);

function fixture() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
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
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
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
    lockId: 'lock-001',
    projectId: 'default',
    manifest,
    plan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${ARTIFACT_DIGEST}`,
      artifactDigest: ARTIFACT_DIGEST,
      artifactBytes: 2048,
      contentDigest: CONTENT_DIGEST,
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: 'approval-001',
      requestVersion: 1,
      dispatchId: 'dispatch-001',
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const queued = createPluginPackageInstall(lock, {
    installationId: 'install-001',
    mutationId: 'mutation-create',
    occurredAtMs: 201,
  });
  const staged = transitionPluginPackageInstall(lock, queued, {
    type: 'stage_completed',
    mutationId: 'mutation-stage',
    occurredAtMs: 202,
    stageRef: `local-stage:${lock.lockDigest}`,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'e'.repeat(64),
  });
  return { lock, staged };
}

class MemoryRepository {
  constructor(lock, record) {
    this.lock = lock;
    this.record = record;
    this.commits = [];
  }

  async find(projectId, packageName) {
    return this.record.projectId === projectId &&
      this.record.packageName === packageName
      ? this.record
      : null;
  }

  async findLock(lockDigest) {
    return this.lock.lockDigest === lockDigest ? this.lock : null;
  }

  async commit(command) {
    const canonical = pluginPackageInstallCommit(this.record, command.record);
    assert.deepEqual(command, canonical);
    this.record = command.record;
    this.commits.push(command);
    return { status: 'committed', record: this.record };
  }
}

function publishedReceipt(lock, record, activatedAtMs = 204) {
  const intent = createPluginPackageActivationIntent(lock, record);
  return transitionPluginPackageInstall(lock, record, {
    type: 'activation_committed',
    mutationId: 'receipt-preview',
    occurredAtMs: activatedAtMs,
    activationRef: `active:${lock.lockDigest}`,
    intentDigest: intent.intentDigest,
    generation: lock.targetGeneration,
    contentDigest: lock.source.contentDigest,
  }).activationReceipt;
}

function activateOptions() {
  return {
    projectId: 'default',
    packageName: 'example-monitor',
    installationId: 'install-001',
    activationStartedMutationId: 'mutation-activate',
    activationCommittedMutationId: 'mutation-commit',
    startedAtMs: 203,
  };
}

test('binds one activation intent to the exact durable install and stage', () => {
  const { lock, staged } = fixture();
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-activate',
    occurredAtMs: 203,
  });
  const intent = createPluginPackageActivationIntent(lock, activating);
  assert.equal(
    intent.intentDigest,
    pluginPackageActivationIntentDigest(lock, activating),
  );
  assert.deepEqual(normalizePluginPackageActivationIntent(intent), intent);
  assert.equal(intent.stageReceiptDigest, staged.stageReceipt.receiptDigest);
  assert.deepEqual(intent.resourceGeneration.resources, lock.resources);
  assert.throws(
    () =>
      normalizePluginPackageActivationIntent({
        ...intent,
        resourceGeneration: createPluginPackageResourceGenerationFromReferences(
          {
            installationId: intent.installationId,
            projectId: 'other',
            packageName: intent.packageName,
            lockDigest: intent.lockDigest,
            generation: intent.targetGeneration,
            previousActiveLockDigest: intent.previousActiveLockDigest,
            contentDigest: intent.contentDigest,
            resources: intent.resourceGeneration.resources,
          },
        ),
      }),
    /activation resource generation does not match/,
  );
  assert.throws(
    () =>
      normalizePluginPackageActivationIntent({
        ...intent,
        schema: 'qinglong/plugin-package-activation-intent@v1',
      }),
    /activation intent schema is invalid/,
  );
  assert.throws(
    () =>
      normalizePluginPackageActivationIntent({
        ...intent,
        targetGeneration: 0,
      }),
    /activation target generation is invalid/,
  );
  assert.throws(
    () =>
      transitionPluginPackageInstall(lock, activating, {
        type: 'activation_committed',
        mutationId: 'mutation-commit',
        occurredAtMs: 204,
        activationRef: 'active:wrong',
        intentDigest: 'f'.repeat(64),
        generation: 1,
        contentDigest: CONTENT_DIGEST,
      }),
    PluginPackageInstallTransitionConflictError,
  );
});

test('persists activating before publication and commits only an exact receipt', async () => {
  const { lock, staged } = fixture();
  const repository = new MemoryRepository(lock, staged);
  const calls = [];
  const coordinator = new PluginPackageActivationCoordinator({
    repository,
    publisher: {
      async inspect() {
        throw new Error('inspect must not run on the fresh path');
      },
      async publish(intent) {
        calls.push(intent);
        return publishedReceipt(lock, repository.record);
      },
    },
  });
  const active = await coordinator.activate(activateOptions());
  assert.equal(active.state, 'active');
  assert.equal(active.activeLockDigest, lock.lockDigest);
  assert.equal(repository.commits.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intentDigest, active.activationReceipt.intentDigest);
});

test('recovers publish-response loss through inspect without republishing', async () => {
  const { lock, staged } = fixture();
  const repository = new MemoryRepository(lock, staged);
  let durableReceipt;
  const publisher = {
    async publish() {
      durableReceipt = publishedReceipt(lock, repository.record);
      throw new Error('response lost');
    },
    async inspect() {
      return { status: 'published', receipt: durableReceipt };
    },
  };
  const coordinator = new PluginPackageActivationCoordinator({
    repository,
    publisher,
  });
  await assert.rejects(
    coordinator.activate(activateOptions()),
    PluginPackageActivationUnavailableError,
  );
  assert.equal(repository.record.state, 'activating');
  const active = await coordinator.inspect({
    projectId: 'default',
    packageName: 'example-monitor',
    installationId: 'install-001',
    activationCommittedMutationId: 'mutation-commit-recovery',
    activationFailedMutationId: 'mutation-fail-recovery',
    observedAtMs: 205,
  });
  assert.equal(active.state, 'active');
  assert.equal(repository.commits.length, 2);
});

test('fails a recovered activating record when exact publication is absent', async () => {
  const { lock, staged } = fixture();
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-activate',
    occurredAtMs: 203,
  });
  const repository = new MemoryRepository(lock, activating);
  const coordinator = new PluginPackageActivationCoordinator({
    repository,
    publisher: {
      async publish() {
        throw new Error('publish must not run during recovery');
      },
      async inspect() {
        return { status: 'not_published' };
      },
    },
  });
  const failed = await coordinator.inspect({
    projectId: 'default',
    packageName: 'example-monitor',
    installationId: 'install-001',
    activationCommittedMutationId: 'mutation-commit-recovery',
    activationFailedMutationId: 'mutation-fail-recovery',
    observedAtMs: 204,
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure.reason, 'activation_failed');
  assert.equal(failed.activeLockDigest, null);
});

test('records a conflicting external fact without replacing the old pointer', async () => {
  const { lock, staged } = fixture();
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-activate',
    occurredAtMs: 203,
  });
  const repository = new MemoryRepository(lock, activating);
  const coordinator = new PluginPackageActivationCoordinator({
    repository,
    publisher: {
      async publish() {
        throw new Error('publish must not run during recovery');
      },
      async inspect() {
        throw new PluginPackageActivationConflictError();
      },
    },
  });
  const failed = await coordinator.inspect({
    projectId: 'default',
    packageName: 'example-monitor',
    installationId: 'install-001',
    activationCommittedMutationId: 'mutation-commit-recovery',
    activationFailedMutationId: 'mutation-fact-conflict',
    observedAtMs: 204,
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure.reason, 'activation_fact_conflict');
  assert.equal(failed.activeLockDigest, null);
});

test('publishes the coordinator only through its explicit subpath', () => {
  assert.equal(
    require('../dist').PluginPackageActivationCoordinator,
    undefined,
  );
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-activation')
      .PluginPackageActivationCoordinator,
    PluginPackageActivationCoordinator,
  );
});
