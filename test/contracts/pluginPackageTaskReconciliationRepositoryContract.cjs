const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackage');
const {
  createPluginPackageLock,
  createPluginPackageInstall,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
  serializePluginPackageManifest,
  transitionPluginPackageInstall,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/installation/pluginPackageInstall');
const {
  pluginPackageContentTreeDigest,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageBundle');
const {
  createPluginPackagePublisherProvenance,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/publisher/pluginPackagePublisherProvenance');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceGeneration');
const {
  materializePluginPackageResources,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceMaterialization');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../../packages/ql3-runtime-core/dist/task-definition/taskSpecSemantic');

function environment(profile) {
  return {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: profile,
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
}

function taskValue(id, argument = id) {
  const command =
    typeof argument === 'string'
      ? {
          kind: 'argv',
          file: '/usr/bin/printf',
          args: [argument],
        }
      : argument;
  return {
    schema: 'qinglong/plugin-package-task-resource@v1',
    id,
    name: `Task ${id}`,
    labels: { 'plugin.qinglong.io/source': 'contract' },
    enabled: true,
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command,
      },
    },
  };
}

function activeRecord(lock, namespace, previousHead = null) {
  const queued = createPluginPackageInstall(lock, {
    installationId: `install-${namespace}-${lock.targetGeneration}`,
    mutationId: `create-${namespace}-${lock.targetGeneration}`,
    occurredAtMs: 1_000 + lock.targetGeneration * 10,
  });
  const staged = transitionPluginPackageInstall(lock, queued, {
    type: 'stage_completed',
    mutationId: `stage-${namespace}-${lock.targetGeneration}`,
    occurredAtMs: queued.updatedAtMs + 1,
    stageRef: `stage:${lock.lockDigest}`,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: createHash('sha256')
      .update(`evidence-${namespace}-${lock.targetGeneration}`)
      .digest('hex'),
  });
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: `activate-${namespace}-${lock.targetGeneration}`,
    occurredAtMs: staged.updatedAtMs + 1,
  });
  const active = transitionPluginPackageInstall(lock, activating, {
    type: 'activation_committed',
    mutationId: `commit-${namespace}-${lock.targetGeneration}`,
    occurredAtMs: activating.updatedAtMs + 1,
    activationRef: `activation:${lock.lockDigest}`,
    intentDigest: pluginPackageActivationIntentDigest(lock, activating),
    generation: lock.targetGeneration,
    contentDigest: lock.source.contentDigest,
  });
  return {
    queued,
    staged,
    activating,
    active,
    create: pluginPackageInstallCreate(lock, queued, previousHead),
    commits: [
      pluginPackageInstallCommit(queued, staged),
      pluginPackageInstallCommit(staged, activating),
      pluginPackageInstallCommit(activating, active),
    ],
  };
}

function fixture(namespace, options = {}) {
  const profile = options.profile ?? 'edge';
  const previous = options.previous ?? null;
  const generation = previous ? previous.generation + 1 : 1;
  const packageName = `package-${namespace}`;
  const projectId = `project-${namespace}`;
  const tasks = options.tasks ?? [
    ['alpha', 'alpha'],
    ['beta', 'beta'],
  ];
  const workflows = options.workflows ?? [];
  const prompts = options.prompts ?? [];
  const tools = options.tools ?? [];
  const taskResources = tasks.map(([id, argument]) => {
    const path = `tasks/${id}.json`;
    const bytes = Buffer.from(JSON.stringify(taskValue(id, argument)));
    return {
      reference: { kind: 'task', path },
      bytes,
      descriptor: {
        path,
        bytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  });
  const toolResources = tools.map((definition, index) => {
    const path = `tools/tool-${index}.json`;
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 'qinglong/plugin-package-tool-resource@v1',
        definition,
      }),
    );
    return {
      reference: { kind: 'tool', path },
      bytes,
      descriptor: {
        path,
        bytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  });
  const workflowResources = workflows.map((value) => {
    const path = `workflows/${value.id}.json`;
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      reference: { kind: 'workflow', path },
      bytes,
      descriptor: {
        path,
        bytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  });
  const promptResources = prompts.map((value) => {
    const path = `prompts/${value.id}.json`;
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      reference: { kind: 'prompt', path },
      bytes,
      descriptor: {
        path,
        bytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  });
  const resources = [
    ...taskResources,
    ...workflowResources,
    ...promptResources,
    ...toolResources,
  ].sort((left, right) =>
    left.reference.path.localeCompare(right.reference.path),
  );
  const contentDigest = pluginPackageContentTreeDigest(
    resources.map(({ descriptor }) => descriptor),
  );
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: packageName,
      displayName: packageName,
      version: `${generation}.0.0`,
      description: 'Task reconciliation contract package',
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
        tools: [
          ...new Set([
            'system.command',
            ...tools.flatMap(
              ({ requiredPermissions = [] }) => requiredPermissions,
            ),
          ]),
        ].sort(),
      },
      contents: {
        tasks: taskResources.map(({ reference }) => reference.path),
        workflows: workflowResources.map(({ reference }) => reference.path),
        prompts: promptResources.map(({ reference }) => reference.path),
        tools: toolResources.map(({ reference }) => reference.path),
      },
    },
  };
  const installEnvironment = environment(profile);
  const plan = planPluginPackageInstall(
    manifest,
    installEnvironment,
    previous?.manifest,
  );
  const action = {
    lockId: `lock-${namespace}-${generation}`,
    projectId,
    manifest,
    plan,
    environment: installEnvironment,
    ...(previous ? { previousManifest: previous.manifest } : {}),
    source: {
      kind: 'offline',
      locator: `offline:sha256:${createHash('sha256')
        .update(`artifact-${namespace}-${generation}`)
        .digest('hex')}`,
      artifactDigest: createHash('sha256')
        .update(`artifact-${namespace}-${generation}`)
        .digest('hex'),
      artifactBytes: 2048,
      contentDigest,
    },
    architecture: 'arm64',
    deploymentProfile: profile,
    targetGeneration: generation,
    ...(previous ? { previousLockDigest: previous.lock.lockDigest } : {}),
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: `approval-${namespace}-${generation}`,
      requestVersion: 1,
      dispatchId: `dispatch-${namespace}-${generation}`,
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 100_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200 + generation,
  });
  const generationRecord = createPluginPackageResourceGenerationFromReferences({
    installationId: `install-${namespace}-${generation}`,
    projectId,
    packageName,
    lockDigest: lock.lockDigest,
    generation,
    previousActiveLockDigest: previous?.lock.lockDigest ?? null,
    contentDigest,
    resources: lock.resources,
  });
  const registry =
    previous?.registry ?? createBuiltInTaskSpecSemanticRegistry();
  const revision = materializePluginPackageResources({
    generation: generationRecord,
    lock,
    manifestBytes: Buffer.from(serializePluginPackageManifest(manifest)),
    resources: resources.map(({ reference, bytes }) => ({ reference, bytes })),
    taskSpecSemanticRegistry: registry,
  });
  const install = activeRecord(
    lock,
    namespace,
    previous?.install.active ?? null,
  );
  return {
    namespace,
    profile,
    projectId,
    packageName,
    generation,
    manifest,
    lock,
    revision,
    registry,
    install,
    manifestBytes: Buffer.from(serializePluginPackageManifest(manifest)),
    resourceEntries: resources.map(({ reference, bytes }) => ({
      reference,
      bytes,
    })),
  };
}

async function activateInstall(repository, value) {
  await repository.create(value.install.create);
  for (const command of value.install.commits) {
    await repository.commit(command);
  }
}

function publisherProvenanceInstallRepository(repository, provenance) {
  return Object.freeze({
    find: (...args) => repository.find(...args),
    findLock: (...args) => repository.findLock(...args),
    create: (...args) => repository.create(...args),
    listRecoveryPage: (...args) => repository.listRecoveryPage(...args),
    async commit(command) {
      if (command.record.state !== 'staged') {
        return repository.commit(command);
      }
      const lock = await repository.findLock(command.record.lockDigest);
      assert.ok(lock);
      assert.ok(command.record.stageReceipt);
      return provenance.commitStage(
        command,
        createPluginPackagePublisherProvenance({
          projectId: command.record.projectId,
          packageName: command.record.packageName,
          installationId: command.record.installationId,
          lockDigest: command.record.lockDigest,
          artifactDigest: command.record.stageReceipt.artifactDigest,
          manifestDigest: command.record.stageReceipt.manifestDigest,
          contentDigest: command.record.stageReceipt.contentDigest,
          stageEvidenceDigest: command.record.stageReceipt.evidenceDigest,
          signature: {
            publisher: 'packages.contract.qinglong.dev',
            keyId: 'contract-key-1',
            signatureDigest: createHash('sha256')
              .update(`signature:${command.record.installationId}`)
              .digest('hex'),
            keyNotBeforeMs: 0,
            keyNotAfterMs: 100_000,
            verifiedAtMs: command.record.updatedAtMs,
          },
        }),
        'cluster',
      );
    },
  });
}

function registerPluginPackageTaskReconciliationRepositoryContract(options) {
  test(`${options.name} reconciles one complete generation and exact replay`, async (t) => {
    const first = fixture(`${options.namespace}-create`, {
      profile: options.profile,
    });
    const harness = await options.createRepository(t, first);
    t.after(() => harness.close?.());
    await activateInstall(harness.installRepository, first);
    await harness.materializedRepository.publish(first.revision);
    assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
      candidates: [
        { projectId: first.projectId, packageName: first.packageName },
      ],
      truncated: false,
    });
    const source = {
      async findActiveResourceGeneration() {
        return first.revision.generation;
      },
    };
    const created = await harness.repository.reconcile(first.revision, source);
    assert.equal(created.status, 'created');
    assert.deepEqual(
      created.receipt.items.map(({ disposition }) => disposition),
      ['created', 'created'],
    );
    assert.equal(
      (await harness.repository.reconcile(first.revision, source)).status,
      'existing',
    );
    assert.deepEqual(
      await harness.repository.find(first.revision.generation.generationDigest),
      created.receipt,
    );
    assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
      candidates: [],
      truncated: false,
    });
    await options.assertGenericWriteRejected?.(harness, first);
  });

  test(`${options.name} retains, disables and creates as one next generation`, async (t) => {
    const first = fixture(`${options.namespace}-upgrade`, {
      profile: options.profile,
    });
    const harness = await options.createRepository(t, first);
    t.after(() => harness.close?.());
    await activateInstall(harness.installRepository, first);
    await harness.materializedRepository.publish(first.revision);
    await harness.repository.reconcile(first.revision, {
      async findActiveResourceGeneration() {
        return first.revision.generation;
      },
    });

    const second = fixture(first.namespace, {
      profile: options.profile,
      previous: first,
      tasks: [
        ['alpha', 'alpha'],
        ['gamma', 'gamma'],
      ],
    });
    await activateInstall(harness.installRepository, second);
    await harness.materializedRepository.publish(second.revision);
    const reconciled = await harness.repository.reconcile(second.revision, {
      async findActiveResourceGeneration() {
        return second.revision.generation;
      },
    });
    assert.deepEqual(
      reconciled.receipt.items.map(({ taskId, revision, disposition }) => ({
        taskId,
        revision,
        disposition,
      })),
      [
        {
          taskId: `pkg:${first.packageName}:alpha`,
          revision: 1,
          disposition: 'retained',
        },
        {
          taskId: `pkg:${first.packageName}:beta`,
          revision: 2,
          disposition: 'disabled',
        },
        {
          taskId: `pkg:${first.packageName}:gamma`,
          revision: 1,
          disposition: 'created',
        },
      ],
    );
    await options.assertDurableUpgrade?.(harness, second);
  });
}

module.exports = {
  activateInstall,
  pluginPackageTaskReconciliationFixture: fixture,
  publisherProvenanceInstallRepository,
  registerPluginPackageTaskReconciliationRepositoryContract,
};
