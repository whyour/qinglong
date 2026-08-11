const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
  PluginPackageActivationConflictError,
  PluginPackageActivationUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-activation');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  PluginPackageInstallTransitionConflictError,
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  PluginPackageRecoveryCoordinator,
} = require('@qinglong/runtime-core/plugin-package-recovery');
const {
  PluginPackageKubernetesActivationPublisher,
} = require('../dist/plugin-package/recovery/pluginPackageKubernetesActivation');

function apiError(code) {
  return Object.assign(new Error(`Kubernetes API ${code}`), { code });
}

class FakeConfigMapApi {
  constructor() {
    this.items = new Map();
    this.revision = 0;
    this.createCalls = 0;
    this.replaceCalls = 0;
    this.readCalls = 0;
    this.beforeRead = null;
    this.loseCreateResponse = false;
    this.loseReplaceResponse = false;
  }

  clone(value) {
    return structuredClone(value);
  }

  serverValue(body, current) {
    this.revision += 1;
    return this.clone({
      ...body,
      metadata: {
        ...body.metadata,
        uid: current?.metadata.uid ?? `uid-${this.revision}`,
        resourceVersion: String(this.revision),
      },
    });
  }

  async readNamespacedConfigMap({ namespace, name }) {
    this.readCalls += 1;
    await this.beforeRead?.(this.readCalls);
    const current = this.items.get(`${namespace}/${name}`);
    if (!current) throw apiError(404);
    return this.clone(current);
  }

  async createNamespacedConfigMap({ namespace, body }) {
    this.createCalls += 1;
    const key = `${namespace}/${body.metadata.name}`;
    if (this.items.has(key)) throw apiError(409);
    const created = this.serverValue(body, null);
    this.items.set(key, created);
    if (this.loseCreateResponse) {
      this.loseCreateResponse = false;
      throw new Error('create response lost');
    }
    return this.clone(created);
  }

  async replaceNamespacedConfigMap({ namespace, name, body }) {
    this.replaceCalls += 1;
    const key = `${namespace}/${name}`;
    const current = this.items.get(key);
    if (
      !current ||
      body.metadata.resourceVersion !== current.metadata.resourceVersion
    ) {
      throw apiError(409);
    }
    const replaced = this.serverValue(body, current);
    this.items.set(key, replaced);
    if (this.loseReplaceResponse) {
      this.loseReplaceResponse = false;
      throw new Error('replace response lost');
    }
    return this.clone(replaced);
  }
}

function intent(overrides = {}) {
  const lockDigest = overrides.lockDigest ?? 'a'.repeat(64);
  const installationId = overrides.installationId ?? 'install-001';
  const targetGeneration = overrides.targetGeneration ?? 1;
  const previousActiveLockDigest = overrides.previousActiveLockDigest ?? null;
  const contentDigest = overrides.contentDigest ?? 'd'.repeat(64);
  const resourceGeneration = createPluginPackageResourceGeneration({
    installationId,
    projectId: 'default',
    packageName: 'example-monitor',
    lockDigest,
    generation: targetGeneration,
    previousActiveLockDigest,
    contentDigest,
    contents: {
      tasks: ['tasks/example.yaml'],
      workflows: [],
      prompts: [],
      tools: [],
    },
  });
  return Object.freeze({
    schema: PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
    installationId,
    projectId: 'default',
    packageName: 'example-monitor',
    lockDigest,
    targetGeneration,
    previousActiveLockDigest,
    stageRef: `cluster-stage:${lockDigest}`,
    stageReceiptDigest: overrides.stageReceiptDigest ?? 'b'.repeat(64),
    stageEvidenceDigest: overrides.stageEvidenceDigest ?? 'c'.repeat(64),
    contentDigest,
    resourceGeneration: overrides.resourceGeneration ?? resourceGeneration,
    intentDigest: overrides.intentDigest ?? 'e'.repeat(64),
  });
}

function exactEvidence(value) {
  return Object.freeze({
    lockDigest: value.lockDigest,
    stageRef: value.stageRef,
    stageReceiptDigest: value.stageReceiptDigest,
    stageEvidenceDigest: value.stageEvidenceDigest,
    contentDigest: value.contentDigest,
  });
}

function stagedInstallFixture() {
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
        deploymentProfiles: ['cluster-control'],
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
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  const action = {
    lockId: 'lock-cluster-install',
    projectId: 'default',
    manifest,
    plan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 2048,
      contentDigest: 'd'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: 'approval-cluster-install',
      requestVersion: 1,
      dispatchId: 'dispatch-cluster-install',
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
    installationId: 'install-cluster-recovery',
    mutationId: 'mutation-cluster-create',
    occurredAtMs: 201,
  });
  const staged = transitionPluginPackageInstall(lock, queued, {
    type: 'stage_completed',
    mutationId: 'mutation-cluster-stage',
    occurredAtMs: 202,
    stageRef: `cluster-stage:${lock.lockDigest}`,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'c'.repeat(64),
  });
  return { lock, staged };
}

class MemoryInstallRepository {
  constructor(lock, record) {
    this.lock = lock;
    this.record = record;
  }

  async find(projectId, packageName) {
    return this.record.projectId === projectId &&
      this.record.packageName === packageName
      ? this.record
      : null;
  }

  async findLock(lockDigest) {
    return lockDigest === this.lock.lockDigest ? this.lock : null;
  }

  async commit(command) {
    const canonical = pluginPackageInstallCommit(this.record, command.record);
    assert.deepEqual(command, canonical);
    if (
      command.expectedVersion !== this.record.version ||
      command.expectedRecordDigest !== this.record.recordDigest
    ) {
      throw new PluginPackageInstallTransitionConflictError();
    }
    this.record = command.record;
    return { status: 'committed', record: this.record };
  }

  async listRecoveryPage({ limit }) {
    const records = ['queued', 'staged', 'activating'].includes(
      this.record.state,
    )
      ? [this.record].slice(0, limit)
      : [];
    return { records, truncated: false };
  }
}

function publisher(api = new FakeConfigMapApi(), overrides = {}) {
  let nowCalls = 0;
  const value = new PluginPackageKubernetesActivationPublisher(
    api,
    {
      async verify(activationIntent) {
        return overrides.verify
          ? overrides.verify(activationIntent)
          : exactEvidence(activationIntent);
      },
    },
    {
      clusterIdentity: 'cluster-primary',
      namespace: 'qinglong-system',
      now() {
        nowCalls += 1;
        return overrides.now?.() ?? 500 + nowCalls;
      },
    },
  );
  return { api, publisher: value, nowCalls: () => nowCalls };
}

test('publishes one resourceVersion-fenced ConfigMap and exact replays it', async () => {
  const fixture = publisher();
  const value = intent();
  assert.equal(
    await fixture.publisher.findActiveResourceGeneration(
      'default',
      'example-monitor',
    ),
    null,
  );
  assert.deepEqual(await fixture.publisher.inspect(value), {
    status: 'not_published',
  });
  const receipt = await fixture.publisher.publish(value);
  assert.equal(receipt.intentDigest, value.intentDigest);
  assert.match(receipt.activationRef, /^k8s-configmap:[0-9a-f]{64}$/);
  assert.deepEqual(await fixture.publisher.inspect(value), {
    status: 'published',
    receipt,
  });
  assert.deepEqual(await fixture.publisher.publish(value), receipt);
  assert.deepEqual(
    await fixture.publisher.findActiveResourceGeneration(
      'default',
      'example-monitor',
    ),
    value.resourceGeneration,
  );
  await assert.rejects(
    fixture.publisher.findActiveResourceGeneration(
      'default',
      'Example_Monitor',
    ),
    TypeError,
  );
  assert.equal(fixture.api.createCalls, 1);
  assert.equal(fixture.api.replaceCalls, 0);
  assert.equal(fixture.nowCalls(), 1);
  const [stored] = fixture.api.items.values();
  assert.match(stored.metadata.name, /^ql3p-[0-9a-f]{52}$/);
  assert.equal(Object.keys(stored.data).join(','), 'active.json');
  assert.equal(
    stored.metadata.labels['app.kubernetes.io/managed-by'],
    'qinglong3',
  );
});

test('replaces only the exact previous lock and rejects a stale writer', async () => {
  const fixture = publisher();
  const first = intent();
  await fixture.publisher.publish(first);
  const second = intent({
    installationId: 'install-002',
    lockDigest: '1'.repeat(64),
    targetGeneration: 2,
    previousActiveLockDigest: first.lockDigest,
    stageReceiptDigest: '2'.repeat(64),
    stageEvidenceDigest: '3'.repeat(64),
    contentDigest: '4'.repeat(64),
    intentDigest: '5'.repeat(64),
  });
  const receipt = await fixture.publisher.publish(second);
  assert.equal(receipt.generation, 2);
  assert.equal(fixture.api.replaceCalls, 1);
  assert.deepEqual(
    await fixture.publisher.findActiveResourceGeneration(
      'default',
      'example-monitor',
    ),
    second.resourceGeneration,
  );

  const stale = intent({
    installationId: 'install-003',
    lockDigest: '6'.repeat(64),
    targetGeneration: 3,
    previousActiveLockDigest: first.lockDigest,
    stageReceiptDigest: '7'.repeat(64),
    stageEvidenceDigest: '8'.repeat(64),
    contentDigest: '9'.repeat(64),
    intentDigest: '0'.repeat(64),
  });
  await assert.rejects(
    fixture.publisher.publish(stale),
    PluginPackageActivationConflictError,
  );
});

test('leaves response loss for recovery inspection without republishing', async () => {
  const api = new FakeConfigMapApi();
  api.loseCreateResponse = true;
  const fixture = publisher(api);
  const value = intent();
  await assert.rejects(
    fixture.publisher.publish(value),
    PluginPackageActivationUnavailableError,
  );
  assert.equal(api.createCalls, 1);
  const observation = await fixture.publisher.inspect(value);
  assert.equal(observation.status, 'published');
  assert.deepEqual(await fixture.publisher.publish(value), observation.receipt);
  assert.equal(api.createCalls, 1);
  assert.equal(fixture.nowCalls(), 1);
});

test('converges a lost Kubernetes publish response through durable startup recovery', async () => {
  const value = stagedInstallFixture();
  const repository = new MemoryInstallRepository(value.lock, value.staged);
  const api = new FakeConfigMapApi();
  api.loseCreateResponse = true;
  const fixture = publisher(api);
  const coordinator = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: {
      async stage() {
        throw new Error('a staged recovery must not restage');
      },
    },
    publisher: fixture.publisher,
    now: () => 250,
  });

  const first = await coordinator.recover();
  assert.equal(first.retry, 1);
  assert.equal(first.safeToAdmit, false);
  assert.equal(repository.record.state, 'activating');
  assert.equal(api.createCalls, 1);

  const second = await coordinator.recover();
  assert.equal(second.settled, 1);
  assert.equal(second.safeToAdmit, true);
  assert.equal(repository.record.state, 'active');
  assert.equal(api.createCalls, 1);
});

test('gives two concurrent replacements from one resourceVersion one winner', async () => {
  const fixture = publisher();
  const first = intent();
  await fixture.publisher.publish(first);
  const left = intent({
    installationId: 'install-left',
    lockDigest: '1'.repeat(64),
    targetGeneration: 2,
    previousActiveLockDigest: first.lockDigest,
    stageReceiptDigest: '2'.repeat(64),
    stageEvidenceDigest: '3'.repeat(64),
    contentDigest: '4'.repeat(64),
    intentDigest: '5'.repeat(64),
  });
  const right = intent({
    installationId: 'install-right',
    lockDigest: '6'.repeat(64),
    targetGeneration: 2,
    previousActiveLockDigest: first.lockDigest,
    stageReceiptDigest: '7'.repeat(64),
    stageEvidenceDigest: '8'.repeat(64),
    contentDigest: '9'.repeat(64),
    intentDigest: '0'.repeat(64),
  });
  const results = await Promise.allSettled([
    fixture.publisher.publish(left),
    fixture.publisher.publish(right),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof PluginPackageActivationConflictError,
    ).length,
    1,
  );
  const winner = results[0].status === 'fulfilled' ? left : right;
  assert.equal((await fixture.publisher.inspect(winner)).status, 'published');
});

test('does not overwrite a winner published between its two reads', async () => {
  const fixture = publisher();
  const first = intent();
  await fixture.publisher.publish(first);
  const winner = intent({
    installationId: 'install-winner',
    lockDigest: '1'.repeat(64),
    targetGeneration: 2,
    previousActiveLockDigest: first.lockDigest,
    stageReceiptDigest: '2'.repeat(64),
    stageEvidenceDigest: '3'.repeat(64),
    contentDigest: '4'.repeat(64),
    intentDigest: '5'.repeat(64),
  });
  const stale = intent({
    installationId: 'install-stale',
    lockDigest: '6'.repeat(64),
    targetGeneration: 2,
    previousActiveLockDigest: first.lockDigest,
    stageReceiptDigest: '7'.repeat(64),
    stageEvidenceDigest: '8'.repeat(64),
    contentDigest: '9'.repeat(64),
    intentDigest: '0'.repeat(64),
  });
  fixture.api.readCalls = 0;
  fixture.api.beforeRead = async (readCalls) => {
    if (readCalls !== 2) return;
    fixture.api.beforeRead = null;
    await fixture.publisher.publish(winner);
  };
  await assert.rejects(
    fixture.publisher.publish(stale),
    PluginPackageActivationConflictError,
  );
  assert.equal((await fixture.publisher.inspect(winner)).status, 'published');
  assert.equal(fixture.api.replaceCalls, 1);
});

test('fails closed on stage evidence or ConfigMap pointer drift', async () => {
  const drifted = publisher(new FakeConfigMapApi(), {
    verify(value) {
      return { ...exactEvidence(value), stageEvidenceDigest: 'f'.repeat(64) };
    },
  });
  await assert.rejects(
    drifted.publisher.publish(intent()),
    PluginPackageActivationConflictError,
  );
  assert.equal(drifted.api.createCalls, 0);

  const fixture = publisher();
  const value = intent();
  await fixture.publisher.publish(value);
  const [key, stored] = fixture.api.items.entries().next().value;
  fixture.api.items.set(key, {
    ...stored,
    metadata: {
      ...stored.metadata,
      labels: {
        ...stored.metadata.labels,
        'qinglong.io/plugin-package-active': 'v1',
      },
    },
  });
  await assert.rejects(
    fixture.publisher.findActiveResourceGeneration(
      'default',
      'example-monitor',
    ),
    PluginPackageActivationConflictError,
  );
  fixture.api.items.set(key, {
    ...stored,
    data: { 'active.json': `${stored.data['active.json']} ` },
  });
  await assert.rejects(
    fixture.publisher.inspect(value),
    PluginPackageActivationConflictError,
  );
});

test('keeps the Kubernetes publisher behind one explicit cluster-admin subpath', () => {
  assert.equal(
    require('@qinglong/cluster-admin')
      .PluginPackageKubernetesActivationPublisher,
    undefined,
  );
  assert.equal(
    require('@qinglong/cluster-admin/plugin-package-kubernetes-activation')
      .PluginPackageKubernetesActivationPublisher,
    PluginPackageKubernetesActivationPublisher,
  );
});
