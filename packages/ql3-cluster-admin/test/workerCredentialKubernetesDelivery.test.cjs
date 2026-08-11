const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  workerCredentialDeliveryTokenDigest,
} = require('@qinglong/runtime-core/worker-credential-delivery');
const {
  formatWorkerCredentialToken,
} = require('@qinglong/runtime-core/worker-credential-token');
const {
  MAX_WORKER_CREDENTIAL_KUBERNETES_STAGES,
  WorkerCredentialKubernetesDeliveryAdapter,
  workerCredentialKubernetesDeploymentTargetDigest,
} = require('@qinglong/cluster-admin/worker-credential-kubernetes-delivery');

const IDS = [
  '123e4567-e89b-42d3-a456-426614174901',
  '123e4567-e89b-42d3-a456-426614174902',
  '123e4567-e89b-42d3-a456-426614174903',
];

function apiError(code) {
  return Object.assign(new Error(`Kubernetes API ${code}`), { code });
}

function copy(value) {
  return structuredClone(value);
}

class FakeKubernetesSecretApi {
  constructor() {
    this.items = new Map();
    this.deployments = new Map();
    this.revision = 0;
    this.uid = 0;
    this.failAfterCreate = false;
    this.failAfterReplace = false;
    this.failBeforeDeploymentReplace = false;
    this.failAfterDeploymentReplace = false;
    this.failAfterDelete = false;
    this.replacements = [];
    this.deploymentReplacements = [];
    this.deletions = [];
    const preparedTarget = this.serverSecret('qinglong-workers', {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: 'edge-router-1-credential',
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration':
            '{"kind":"Secret","metadata":{"name":"edge-router-1-credential"}}',
        },
        labels: {
          'app.kubernetes.io/managed-by': 'qinglong3',
          'qinglong.io/worker-credential-target': 'prepared-v3',
        },
      },
      data: {},
    }, null);
    this.items.set(
      this.key('qinglong-workers', 'edge-router-1-credential'),
      preparedTarget,
    );
    const deployment = this.serverDeployment('qinglong-workers', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'edge-router-1',
        labels: { 'app.kubernetes.io/component': 'worker' },
      },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        template: {
          metadata: {
            labels: { 'app.kubernetes.io/component': 'worker' },
          },
          spec: {
            containers: [{ name: 'worker', image: 'worker:test' }],
            volumes: [{
              name: 'projected-authority',
              projected: {
                sources: [{
                  secret: {
                    name: 'edge-router-1-credential',
                    items: [{
                      key: 'credential.token',
                      path: 'credential-token',
                    }],
                  },
                }],
              },
            }],
          },
        },
      },
    }, null);
    this.deployments.set(this.key('qinglong-workers', 'edge-router-1'), deployment);
  }

  key(namespace, name) {
    return `${namespace}/${name}`;
  }

  serverSecret(namespace, body, current) {
    this.revision += 1;
    const metadata = body.metadata ?? {};
    return {
      ...copy(body),
      metadata: {
        ...copy(metadata),
        namespace,
        uid: current?.metadata?.uid ?? `uid-${++this.uid}`,
        resourceVersion: String(this.revision),
      },
    };
  }

  serverDeployment(namespace, body, current) {
    this.revision += 1;
    return {
      ...copy(body),
      metadata: {
        ...copy(body.metadata),
        namespace,
        uid: current?.metadata?.uid ?? `uid-${++this.uid}`,
        resourceVersion: String(this.revision),
      },
    };
  }

  async readNamespacedSecret({ namespace, name }) {
    const value = this.items.get(this.key(namespace, name));
    if (!value) throw apiError(404);
    return copy(value);
  }

  async createNamespacedSecret({ namespace, body }) {
    const key = this.key(namespace, body.metadata.name);
    if (this.items.has(key)) throw apiError(409);
    const created = this.serverSecret(namespace, body, null);
    this.items.set(key, created);
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw apiError(409);
    }
    return copy(created);
  }

  async replaceNamespacedSecret({ namespace, name, body }) {
    const key = this.key(namespace, name);
    const current = this.items.get(key);
    if (!current) throw apiError(404);
    this.replacements.push({
      expectedResourceVersion: body.metadata.resourceVersion,
      observedResourceVersion: current.metadata.resourceVersion,
    });
    if (body.metadata.resourceVersion !== current.metadata.resourceVersion) {
      throw apiError(409);
    }
    const replaced = this.serverSecret(namespace, body, current);
    this.items.set(key, replaced);
    if (this.failAfterReplace) {
      this.failAfterReplace = false;
      throw apiError(409);
    }
    return copy(replaced);
  }

  async deleteNamespacedSecret({ namespace, name, body }) {
    const key = this.key(namespace, name);
    const current = this.items.get(key);
    if (!current) throw apiError(404);
    this.deletions.push(copy(body.preconditions));
    if (
      body.preconditions.uid !== current.metadata.uid ||
      body.preconditions.resourceVersion !== current.metadata.resourceVersion
    ) {
      throw apiError(409);
    }
    this.items.delete(key);
    if (this.failAfterDelete) {
      this.failAfterDelete = false;
      throw apiError(404);
    }
    return { status: 'Success' };
  }

  async listNamespacedSecret({ namespace, limit }) {
    const values = [...this.items.values()].filter((item) =>
      item.metadata.namespace === namespace &&
      item.metadata.labels?.['app.kubernetes.io/managed-by'] === 'qinglong3' &&
      item.metadata.labels?.['qinglong.io/worker-credential-stage'] === 'v1');
    return {
      items: copy(values.slice(0, limit)),
      metadata: values.length > limit ? { _continue: 'opaque' } : {},
    };
  }

  async readNamespacedDeployment({ namespace, name }) {
    const value = this.deployments.get(this.key(namespace, name));
    if (!value) throw apiError(404);
    return copy(value);
  }

  async replaceNamespacedDeployment({ namespace, name, body }) {
    const key = this.key(namespace, name);
    const current = this.deployments.get(key);
    if (!current) throw apiError(404);
    this.deploymentReplacements.push({
      expectedResourceVersion: body.metadata.resourceVersion,
      observedResourceVersion: current.metadata.resourceVersion,
    });
    if (body.metadata.resourceVersion !== current.metadata.resourceVersion) {
      throw apiError(409);
    }
    if (this.failBeforeDeploymentReplace) {
      this.failBeforeDeploymentReplace = false;
      throw apiError(503);
    }
    const replaced = this.serverDeployment(namespace, body, current);
    this.deployments.set(key, replaced);
    if (this.failAfterDeploymentReplace) {
      this.failAfterDeploymentReplace = false;
      throw apiError(409);
    }
    return copy(replaced);
  }

  get(namespace, name) {
    return copy(this.items.get(this.key(namespace, name)));
  }

  getDeployment(namespace, name) {
    return copy(this.deployments.get(this.key(namespace, name)));
  }
}

function adapter(api = new FakeKubernetesSecretApi()) {
  return {
    api,
    adapter: new WorkerCredentialKubernetesDeliveryAdapter(api, api, {
      clusterIdentity: 'cluster-production-a',
      namespace: 'qinglong-workers',
      stageNamespace: 'qinglong-workers-staging',
      targetSecretName: 'edge-router-1-credential',
      targetDeploymentName: 'edge-router-1',
      targetDataKey: 'credential.token',
    }),
  };
}

function token(credentialId, fill) {
  return Buffer.from(formatWorkerCredentialToken(
    credentialId,
    Buffer.alloc(32, fill).toString('base64url'),
  ));
}

function intent(deliveryAdapter, deliveryId, credentialId, material, overrides = {}) {
  return {
    deliveryId,
    workerId: 'edge-router-1',
    credentialId,
    credentialVersion: 1,
    previousCredentialId: null,
    secretDigest: 'a'.repeat(64),
    tokenDigest: workerCredentialDeliveryTokenDigest(material),
    deploymentTargetDigest: deliveryAdapter.deploymentTargetDigest,
    deploymentGeneration: `generation-${credentialId}`,
    stagedAtMs: 1_000,
    ...overrides,
  };
}

function committed(candidate) {
  return {
    ...candidate,
    version: 1,
    state: 'credential_committed',
    credentialCommittedAtMs: candidate.stagedAtMs,
    publishedAtMs: null,
    publicationDigest: null,
    observedAtMs: null,
    observedSessionId: null,
    observedSessionVersion: null,
    previousRevokedAtMs: null,
  };
}

test('plans the exact deployment target digest without Kubernetes authority', () => {
  const options = {
    clusterIdentity: 'cluster-production-a',
    namespace: 'qinglong-workers',
    stageNamespace: 'qinglong-workers-staging',
    targetSecretName: 'edge-router-1-credential',
    targetDeploymentName: 'edge-router-1',
    targetDataKey: 'credential.token',
  };
  const { adapter: delivery } = adapter();
  assert.equal(
    workerCredentialKubernetesDeploymentTargetDigest(options),
    delivery.deploymentTargetDigest,
  );
  assert.throws(
    () => workerCredentialKubernetesDeploymentTargetDigest({
      ...options,
      namespace: options.stageNamespace,
    }),
    /delivery options are invalid/,
  );
});

test('creates one immutable stage and lists only bounded normalized intent', async () => {
  const { api, adapter: delivery } = adapter();
  const material = token('worker_generation_1', 1);
  const candidate = intent(delivery, IDS[0], 'worker_generation_1', material);
  api.failAfterCreate = true;
  await delivery.stage(candidate, material);
  assert.deepEqual(await delivery.inspect(IDS[0]), candidate);
  assert.deepEqual(await delivery.listStaged({ limit: 1 }), {
    stages: [candidate],
    truncated: false,
  });
  const stored = api.get(
    'qinglong-workers-staging',
    `ql3w-stage-${IDS[0].replaceAll('-', '')}`,
  );
  assert.equal(stored.immutable, true);
  assert.equal(stored.type, 'qinglong.io/worker-credential-stage-v1');
  assert.deepEqual(Object.keys(stored.data), ['credentialToken']);

  await delivery.stage(candidate, material);
  await assert.rejects(
    delivery.stage({ ...candidate, deploymentGeneration: 'drift' }, material),
    WorkerCredentialDeliveryConflictError,
  );
  material.fill(0);
});

test('publishes with resourceVersion CAS and replays a lost update response', async () => {
  const { api, adapter: delivery } = adapter();
  const first = token('worker_generation_1', 1);
  const firstIntent = intent(delivery, IDS[0], 'worker_generation_1', first);
  await delivery.stage(firstIntent, first);
  const initial = await delivery.publish(committed(firstIntent));
  assert.match(initial.publicationDigest, /^[0-9a-f]{64}$/);

  const second = token('worker_generation_2', 2);
  const secondIntent = intent(
    delivery,
    IDS[1],
    'worker_generation_2',
    second,
    { previousCredentialId: 'worker_generation_1' },
  );
  await delivery.stage(secondIntent, second);
  api.failAfterReplace = true;
  api.failAfterDeploymentReplace = true;
  const rotated = await delivery.publish(committed(secondIntent));
  assert.match(rotated.publicationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    await delivery.publish(committed(secondIntent)),
    rotated,
  );
  assert.equal(api.replacements.length, 2);
  assert.equal(
    api.replacements[0].expectedResourceVersion,
    api.replacements[0].observedResourceVersion,
  );
  assert.equal(api.deploymentReplacements.length, 2);
  assert.equal(
    api.deploymentReplacements[1].expectedResourceVersion,
    api.deploymentReplacements[1].observedResourceVersion,
  );
  const target = api.get('qinglong-workers', 'edge-router-1-credential');
  assert.match(
    target.metadata.labels['qinglong.io/worker-credential-target-digest'],
    /^[A-Za-z0-9_-]{43}$/,
  );
  assert.deepEqual(
    Buffer.from(target.data['credential.token'], 'base64'),
    second,
  );
  const deployment = api.getDeployment('qinglong-workers', 'edge-router-1');
  const annotations = deployment.spec.template.metadata.annotations;
  assert.equal(
    annotations['qinglong.io/worker-credential-generation'],
    secondIntent.deploymentGeneration,
  );
  assert.equal(
    annotations['qinglong.io/worker-credential-id'],
    secondIntent.credentialId,
  );
  assert.equal(
    annotations['qinglong.io/worker-credential-publication-digest'],
    rotated.publicationDigest,
  );
  first.fill(0);
  second.fill(0);
});

test('recovers a Secret-first crash before advancing the Recreate PodTemplate', async () => {
  const { api, adapter: delivery } = adapter();
  const material = token('worker_generation_1', 1);
  const candidate = intent(delivery, IDS[0], 'worker_generation_1', material);
  await delivery.stage(candidate, material);
  api.failBeforeDeploymentReplace = true;
  await assert.rejects(
    delivery.publish(committed(candidate)),
    WorkerCredentialDeliveryUnavailableError,
  );
  assert.ok(api.get('qinglong-workers', 'edge-router-1-credential'));
  assert.equal(
    api.getDeployment('qinglong-workers', 'edge-router-1')
      .spec.template.metadata.annotations,
    undefined,
  );
  const recovered = await delivery.publish(committed(candidate));
  assert.match(recovered.publicationDigest, /^[0-9a-f]{64}$/);
  assert.equal(api.replacements.length, 1);
  assert.equal(api.deploymentReplacements.length, 2);
  material.fill(0);
});

test('rejects Deployment drift before mutating the target Secret', async () => {
  const { api, adapter: delivery } = adapter();
  const material = token('worker_generation_1', 1);
  const candidate = intent(delivery, IDS[0], 'worker_generation_1', material);
  await delivery.stage(candidate, material);
  api.deployments.get('qinglong-workers/edge-router-1').spec.strategy.type =
    'RollingUpdate';
  await assert.rejects(
    delivery.publish(committed(candidate)),
    WorkerCredentialDeliveryConflictError,
  );
  const prepared = api.get('qinglong-workers', 'edge-router-1-credential');
  assert.equal(
    prepared.metadata.labels['qinglong.io/worker-credential-target'],
    'prepared-v3',
  );
  assert.deepEqual(prepared.data, {});
  material.fill(0);
});

test('gives two concurrent rotations from one resourceVersion exactly one winner', async () => {
  const { adapter: delivery } = adapter();
  const first = token('worker_generation_1', 1);
  const firstIntent = intent(delivery, IDS[0], 'worker_generation_1', first);
  await delivery.stage(firstIntent, first);
  await delivery.publish(committed(firstIntent));

  const second = token('worker_generation_2', 2);
  const third = token('worker_generation_3', 3);
  const secondIntent = intent(delivery, IDS[1], 'worker_generation_2', second, {
    previousCredentialId: 'worker_generation_1',
  });
  const thirdIntent = intent(delivery, IDS[2], 'worker_generation_3', third, {
    previousCredentialId: 'worker_generation_1',
  });
  await delivery.stage(secondIntent, second);
  await delivery.stage(thirdIntent, third);
  const results = await Promise.allSettled([
    delivery.publish(committed(secondIntent)),
    delivery.publish(committed(thirdIntent)),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = results.find((result) => result.status === 'rejected');
  assert.ok(rejection.reason instanceof WorkerCredentialDeliveryConflictError);
  first.fill(0);
  second.fill(0);
  third.fill(0);
});

test('deletes only an exact unpublished stage with UID and resourceVersion fences', async () => {
  const { api, adapter: delivery } = adapter();
  const material = token('worker_generation_1', 1);
  const candidate = intent(delivery, IDS[0], 'worker_generation_1', material);
  await delivery.stage(candidate, material);
  const staged = api.get(
    'qinglong-workers-staging',
    `ql3w-stage-${IDS[0].replaceAll('-', '')}`,
  );
  api.failAfterDelete = true;
  await delivery.discard(candidate);
  assert.equal(await delivery.inspect(IDS[0]), null);
  assert.deepEqual(api.deletions, [{
    uid: staged.metadata.uid,
    resourceVersion: staged.metadata.resourceVersion,
  }]);
  await delivery.discard(candidate);
  material.fill(0);
});

test('never discards a stage whose token is already the published target', async () => {
  const { adapter: delivery } = adapter();
  const material = token('worker_generation_1', 1);
  const candidate = intent(delivery, IDS[0], 'worker_generation_1', material);
  await delivery.stage(candidate, material);
  await delivery.publish(committed(candidate));
  await assert.rejects(
    delivery.discard(candidate),
    WorkerCredentialDeliveryConflictError,
  );
  assert.deepEqual(await delivery.inspect(IDS[0]), candidate);
  material.fill(0);
});

test('fails closed when the Kubernetes stage inventory exceeds its hard cap', async () => {
  const { api, adapter: delivery } = adapter();
  for (let index = 0; index <= MAX_WORKER_CREDENTIAL_KUBERNETES_STAGES; index += 1) {
    api.items.set(`synthetic/${index}`, {
      metadata: {
        namespace: 'qinglong-workers-staging',
        labels: {
          'app.kubernetes.io/managed-by': 'qinglong3',
          'qinglong.io/worker-credential-stage': 'v1',
        },
      },
    });
  }
  await assert.rejects(
    delivery.listStaged(),
    WorkerCredentialDeliveryUnavailableError,
  );
});

test('fails closed when the prepared target Secret is absent or has drifted', async () => {
  const missing = new FakeKubernetesSecretApi();
  missing.items.delete('qinglong-workers/edge-router-1-credential');
  const { adapter: missingDelivery } = adapter(missing);
  const missingMaterial = token('worker_generation_1', 1);
  const missingIntent = intent(
    missingDelivery,
    IDS[0],
    'worker_generation_1',
    missingMaterial,
  );
  await missingDelivery.stage(missingIntent, missingMaterial);
  await assert.rejects(
    missingDelivery.publish(committed(missingIntent)),
    WorkerCredentialDeliveryUnavailableError,
  );
  assert.equal(missing.replacements.length, 0);

  const drifted = new FakeKubernetesSecretApi();
  drifted.items.get('qinglong-workers/edge-router-1-credential')
    .metadata.annotations['unexpected.example/authority'] = 'drift';
  const { adapter: driftedDelivery } = adapter(drifted);
  const driftedMaterial = token('worker_generation_2', 2);
  const driftedIntent = intent(
    driftedDelivery,
    IDS[1],
    'worker_generation_2',
    driftedMaterial,
  );
  await driftedDelivery.stage(driftedIntent, driftedMaterial);
  await assert.rejects(
    driftedDelivery.publish(committed(driftedIntent)),
    WorkerCredentialDeliveryConflictError,
  );
  assert.equal(drifted.replacements.length, 0);

  missingMaterial.fill(0);
  driftedMaterial.fill(0);
});
