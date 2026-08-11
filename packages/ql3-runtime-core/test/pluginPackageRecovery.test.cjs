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
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('../dist/plugin-package/installation/pluginPackageInstall');
const {
  createPluginPackageActivationIntent,
} = require('../dist/plugin-package/installation/pluginPackageActivation');
const {
  PluginPackageRecoveryCoordinator,
} = require('../dist/plugin-package/installation/pluginPackageRecovery');

const ARTIFACT_DIGEST = 'a'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);

function fixture(
  packageName = 'example-monitor',
  installationId = 'install-001',
) {
  const manifest = {
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
    lockId: `lock-${packageName}`,
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
      requestId: `approval-${packageName}`,
      requestVersion: 1,
      dispatchId: `dispatch-${packageName}`,
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
    installationId,
    mutationId: `mutation-create-${packageName}`,
    occurredAtMs: 201,
  });
  return { lock, queued };
}

function stageEvidence(lock) {
  return {
    stageRef: `local-stage:${lock.lockDigest}`,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'e'.repeat(64),
  };
}

function stagedFixture(packageName, installationId) {
  const value = fixture(packageName, installationId);
  const staged = transitionPluginPackageInstall(value.lock, value.queued, {
    type: 'stage_completed',
    mutationId: `mutation-stage-${value.lock.packageName}`,
    occurredAtMs: 202,
    ...stageEvidence(value.lock),
  });
  return { ...value, staged };
}

function activatingFixture(packageName, installationId) {
  const value = stagedFixture(packageName, installationId);
  const activating = transitionPluginPackageInstall(value.lock, value.staged, {
    type: 'activation_started',
    mutationId: `mutation-activate-${value.lock.packageName}`,
    occurredAtMs: 203,
  });
  return { ...value, activating };
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

function compareRecords(left, right) {
  return (
    left.packageName.localeCompare(right.packageName) ||
    left.installationId.localeCompare(right.installationId)
  );
}

class MemoryRepository {
  constructor(values) {
    this.locks = new Map(values.map(({ lock }) => [lock.lockDigest, lock]));
    this.records = new Map(
      values.map(({ queued, record = queued }) => [
        `${record.projectId}\0${record.packageName}`,
        record,
      ]),
    );
    this.commits = [];
    this.commitHook = undefined;
    this.listHook = undefined;
    this.listCalls = 0;
  }

  key(projectId, packageName) {
    return `${projectId}\0${packageName}`;
  }

  async find(projectId, packageName) {
    return this.records.get(this.key(projectId, packageName)) ?? null;
  }

  async findLock(lockDigest) {
    return this.locks.get(lockDigest) ?? null;
  }

  async commit(command) {
    if (this.commitHook) {
      const hooked = await this.commitHook(command);
      if (hooked) return hooked;
    }
    const key = this.key(command.record.projectId, command.record.packageName);
    const current = this.records.get(key);
    if (
      !current ||
      current.installationId !== command.installationId ||
      current.version !== command.expectedVersion ||
      current.recordDigest !== command.expectedRecordDigest
    ) {
      throw new PluginPackageInstallTransitionConflictError();
    }
    this.records.set(key, command.record);
    this.commits.push(command);
    return { status: 'committed', record: command.record };
  }

  async listRecoveryPage(options) {
    this.listCalls += 1;
    if (this.listHook) await this.listHook(this.listCalls);
    const records = [...this.records.values()]
      .filter((record) =>
        ['queued', 'staged', 'activating'].includes(record.state),
      )
      .sort(compareRecords)
      .filter(
        (record) =>
          !options.after ||
          compareRecords(record, {
            packageName: options.after.packageName,
            installationId: options.after.installationId,
          }) > 0,
      );
    const selected = records.slice(0, options.limit);
    const truncated = records.length > selected.length;
    const last = selected.at(-1);
    return {
      records: selected,
      truncated,
      ...(truncated
        ? {
            next: {
              packageName: last.packageName,
              installationId: last.installationId,
            },
          }
        : {}),
    };
  }
}

function publisherFor(repository, calls, external = new Map()) {
  return {
    async publish(intent) {
      calls.publish += 1;
      const record = await repository.find(
        intent.projectId,
        intent.packageName,
      );
      const lock = await repository.findLock(record.lockDigest);
      const receipt = publishedReceipt(lock, record, 300 + calls.publish);
      external.set(intent.intentDigest, receipt);
      return receipt;
    },
    async inspect(intent) {
      calls.inspect += 1;
      const receipt = external.get(intent.intentDigest);
      return receipt
        ? { status: 'published', receipt }
        : { status: 'not_published' };
    },
  };
}

test('recovers queued install through stage and activation without consuming approval', async () => {
  const value = fixture();
  const repository = new MemoryRepository([value]);
  const calls = { stage: 0, publish: 0, inspect: 0 };
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage(lock) {
        calls.stage += 1;
        return stageEvidence(lock);
      },
    },
    publisher: publisherFor(repository, calls),
    now: async () => 250,
  });

  const cycle = await coordinator.recover({ pageSize: 1, maxPages: 2 });

  assert.deepEqual(cycle, {
    pages: 1,
    scanned: 1,
    settled: 1,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.equal(
    (await repository.find('default', 'example-monitor')).state,
    'active',
  );
  assert.deepEqual(calls, { stage: 1, publish: 1, inspect: 0 });
});

test('inspects an activating install without republishing it', async () => {
  const value = activatingFixture();
  const repository = new MemoryRepository([
    { ...value, record: value.activating },
  ]);
  const calls = { stage: 0, publish: 0, inspect: 0 };
  const intent = createPluginPackageActivationIntent(
    value.lock,
    value.activating,
  );
  const external = new Map([
    [intent.intentDigest, publishedReceipt(value.lock, value.activating)],
  ]);
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage() {
        calls.stage += 1;
        throw new Error('stage must not run');
      },
    },
    publisher: publisherFor(repository, calls, external),
    now: () => 250,
  });

  const page = await coordinator.recoverPage({ limit: 1 });

  assert.equal(page.items[0].status, 'settled');
  assert.equal(page.items[0].action, 'inspect_activation');
  assert.equal(
    (await repository.find('default', 'example-monitor')).state,
    'active',
  );
  assert.deepEqual(calls, { stage: 0, publish: 0, inspect: 1 });
});

test('recovers publication response loss by inspecting on the next pass', async () => {
  const value = stagedFixture();
  const repository = new MemoryRepository([{ ...value, record: value.staged }]);
  const calls = { stage: 0, publish: 0, inspect: 0 };
  const external = new Map();
  const basePublisher = publisherFor(repository, calls, external);
  let loseResponse = true;
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage() {
        throw new Error('stage must not run');
      },
    },
    publisher: {
      async publish(intent) {
        const receipt = await basePublisher.publish(intent);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('simulated response loss');
        }
        return receipt;
      },
      inspect: basePublisher.inspect,
    },
    now: () => 250,
  });

  const first = await coordinator.recover();
  assert.equal(first.retry, 1);
  assert.equal(first.safeToAdmit, false);
  assert.equal(
    (await repository.find('default', 'example-monitor')).state,
    'activating',
  );

  const second = await coordinator.recover();
  assert.equal(second.settled, 1);
  assert.equal(second.safeToAdmit, true);
  assert.equal(
    (await repository.find('default', 'example-monitor')).state,
    'active',
  );
  assert.deepEqual(calls, { stage: 0, publish: 1, inspect: 1 });
});

test('does not inspect or publish when another recovery advances queued state', async () => {
  const value = fixture();
  const repository = new MemoryRepository([value]);
  const calls = { stage: 0, publish: 0, inspect: 0 };
  repository.commitHook = async (command) => {
    if (command.record.state !== 'staged') return undefined;
    const activating = transitionPluginPackageInstall(
      value.lock,
      command.record,
      {
        type: 'activation_started',
        mutationId: 'other-recovery-activation',
        occurredAtMs: 251,
      },
    );
    repository.records.set(
      repository.key(activating.projectId, activating.packageName),
      activating,
    );
    repository.commitHook = undefined;
    return { status: 'existing', record: activating };
  };
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage(lock) {
        calls.stage += 1;
        return stageEvidence(lock);
      },
    },
    publisher: publisherFor(repository, calls),
    now: () => 250,
  });

  const page = await coordinator.recoverPage({ limit: 1 });

  assert.equal(page.items[0].status, 'retry');
  assert.equal(page.items[0].state, 'activating');
  assert.deepEqual(calls, { stage: 1, publish: 0, inspect: 0 });
});

test('keeps unavailable stage recoverable and blocks admission', async () => {
  const value = fixture();
  const repository = new MemoryRepository([value]);
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage() {
        throw new Error('artifact store unavailable');
      },
    },
    publisher: publisherFor(repository, { publish: 0, inspect: 0 }),
    now: () => 250,
  });

  const cycle = await coordinator.recover();

  assert.equal(cycle.retry, 1);
  assert.equal(cycle.remaining, true);
  assert.equal(cycle.safeToAdmit, false);
  assert.equal(
    (await repository.find('default', 'example-monitor')).state,
    'queued',
  );
});

test('marks invalid durable stage evidence for manual recovery', async () => {
  const value = fixture();
  const repository = new MemoryRepository([value]);
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage(lock) {
        return { ...stageEvidence(lock), evidenceDigest: 'not-a-digest' };
      },
    },
    publisher: publisherFor(repository, { publish: 0, inspect: 0 }),
    now: () => 250,
  });

  const cycle = await coordinator.recover();

  assert.equal(cycle.manualRequired, 1);
  assert.equal(cycle.safeToAdmit, false);
});

test('uses a final head probe to catch recovery work inserted before the cursor', async () => {
  const first = stagedFixture('middle-package', 'install-middle');
  const last = stagedFixture('zulu-package', 'install-zulu');
  const inserted = stagedFixture('alpha-package', 'install-alpha');
  const repository = new MemoryRepository([
    { ...first, record: first.staged },
    { ...last, record: last.staged },
  ]);
  const calls = { stage: 0, publish: 0, inspect: 0 };
  repository.listHook = async (listCall) => {
    if (listCall !== 2) return;
    repository.locks.set(inserted.lock.lockDigest, inserted.lock);
    repository.records.set(
      repository.key(inserted.staged.projectId, inserted.staged.packageName),
      inserted.staged,
    );
  };
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage() {
        throw new Error('stage must not run');
      },
    },
    publisher: publisherFor(repository, calls),
    now: () => 250,
  });

  const cycle = await coordinator.recover({ pageSize: 1, maxPages: 2 });

  assert.equal(cycle.pages, 2);
  assert.equal(cycle.settled, 2);
  assert.equal(cycle.remaining, true);
  assert.equal(cycle.safeToAdmit, false);
  assert.equal(
    (await repository.find('default', 'alpha-package')).state,
    'staged',
  );
});

test('rejects malformed recovery page ordering and continuation', async () => {
  const first = stagedFixture('alpha-package', 'install-alpha');
  const last = stagedFixture('zulu-package', 'install-zulu');
  const repository = new MemoryRepository([
    { ...first, record: first.staged },
    { ...last, record: last.staged },
  ]);
  repository.listRecoveryPage = async () => ({
    records: [last.staged, first.staged],
    truncated: true,
    next: {
      packageName: first.staged.packageName,
      installationId: first.staged.installationId,
    },
  });
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: { async stage() {} },
    publisher: {
      async publish() {},
      async inspect() {},
    },
    now: () => 250,
  });

  await assert.rejects(
    coordinator.recoverPage({ limit: 2 }),
    /recovery page records are invalid/,
  );
});

test('publishes recovery authority only through its explicit subpath', () => {
  assert.equal(require('../dist').PluginPackageRecoveryCoordinator, undefined);
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-recovery')
      .PluginPackageRecoveryCoordinator,
    PluginPackageRecoveryCoordinator,
  );
});
