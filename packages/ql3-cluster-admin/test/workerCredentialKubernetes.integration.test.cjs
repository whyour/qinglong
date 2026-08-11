const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialDeliveryConflictError,
  workerCredentialDeliveryTokenDigest,
} = require('@qinglong/runtime-core/worker-credential-delivery');
const {
  formatWorkerCredentialToken,
} = require('@qinglong/runtime-core/worker-credential-token');
const {
  WorkerCredentialKubernetesDeliveryAdapter,
} = require('@qinglong/cluster-admin/worker-credential-kubernetes-delivery');

const enabled = Boolean(
  process.env.QL3_TEST_KUBECONFIG &&
  process.env.QL3_TEST_KUBERNETES_NAMESPACE,
);
const integrationTest = enabled ? test : test.skip;

const IDS = [
  '223e4567-e89b-42d3-a456-426614174901',
  '223e4567-e89b-42d3-a456-426614174902',
  '223e4567-e89b-42d3-a456-426614174903',
  '223e4567-e89b-42d3-a456-426614174904',
];

function token(credentialId, fill) {
  return Buffer.from(formatWorkerCredentialToken(
    credentialId,
    Buffer.alloc(32, fill).toString('base64url'),
  ));
}

function intent(adapter, deliveryId, credentialId, material, overrides = {}) {
  return {
    deliveryId,
    workerId: 'integration-worker-1',
    credentialId,
    credentialVersion: 1,
    previousCredentialId: null,
    secretDigest: 'b'.repeat(64),
    tokenDigest: workerCredentialDeliveryTokenDigest(material),
    deploymentTargetDigest: adapter.deploymentTargetDigest,
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

integrationTest(
  'real Kubernetes API enforces resourceVersion single winner and delete preconditions',
  async () => {
    const k8s = await import('@kubernetes/client-node');
    const config = new k8s.KubeConfig();
    config.loadFromFile(process.env.QL3_TEST_KUBECONFIG);
    const api = config.makeApiClient(k8s.CoreV1Api);
    const deployments = config.makeApiClient(k8s.AppsV1Api);
    const namespace = process.env.QL3_TEST_KUBERNETES_NAMESPACE;
    const stageNamespace =
      process.env.QL3_TEST_KUBERNETES_STAGE_NAMESPACE ??
      `${namespace.slice(0, 57)}-stage`;
    await api.createNamespace({
      body: {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: stageNamespace },
      },
    }).catch((error) => {
      if (error?.code !== 409) throw error;
    });
    await api.createNamespacedSecret({
      namespace,
      body: {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
          name: 'integration-worker-credential',
          labels: {
            'app.kubernetes.io/managed-by': 'qinglong3',
            'qinglong.io/worker-credential-target': 'prepared-v3',
          },
        },
        data: {},
      },
    });
    await deployments.createNamespacedDeployment({
      namespace,
      body: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'integration-worker',
          namespace,
          labels: { 'app.kubernetes.io/component': 'worker' },
        },
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: {
            matchLabels: {
              app: 'integration-worker',
              'app.kubernetes.io/component': 'worker',
            },
          },
          template: {
            metadata: {
              labels: {
                app: 'integration-worker',
                'app.kubernetes.io/component': 'worker',
              },
            },
            spec: {
              containers: [{
                name: 'worker',
                image: 'registry.k8s.io/pause:3.10.1',
                volumeMounts: [{
                  name: 'credential',
                  mountPath: '/credential',
                  readOnly: true,
                }],
              }],
              volumes: [{
                name: 'credential',
                projected: {
                  sources: [{
                    secret: {
                      name: 'integration-worker-credential',
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
      },
    });
    const adapter = new WorkerCredentialKubernetesDeliveryAdapter(
      api,
      deployments,
      {
        clusterIdentity: 'ql3-k3s-integration',
        namespace,
        stageNamespace,
        targetSecretName: 'integration-worker-credential',
        targetDeploymentName: 'integration-worker',
        targetDataKey: 'credential.token',
      },
    );

    const first = token('integration_generation_1', 1);
    const firstIntent = intent(
      adapter,
      IDS[0],
      'integration_generation_1',
      first,
    );
    await adapter.stage(firstIntent, first);
    const initial = await adapter.publish(committed(firstIntent));
    assert.match(initial.publicationDigest, /^[0-9a-f]{64}$/);
    const initialTarget = await api.readNamespacedSecret({
      namespace,
      name: 'integration-worker-credential',
    });

    const second = token('integration_generation_2', 2);
    const third = token('integration_generation_3', 3);
    const secondIntent = intent(
      adapter,
      IDS[1],
      'integration_generation_2',
      second,
      { previousCredentialId: 'integration_generation_1' },
    );
    const thirdIntent = intent(
      adapter,
      IDS[2],
      'integration_generation_3',
      third,
      { previousCredentialId: 'integration_generation_1' },
    );
    await adapter.stage(secondIntent, second);
    await adapter.stage(thirdIntent, third);
    const results = await Promise.allSettled([
      adapter.publish(committed(secondIntent)),
      adapter.publish(committed(thirdIntent)),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected.reason instanceof WorkerCredentialDeliveryConflictError);
    const winner = results[0].status === 'fulfilled' ? secondIntent : thirdIntent;
    const target = await api.readNamespacedSecret({
      namespace,
      name: 'integration-worker-credential',
    });
    assert.notEqual(
      target.metadata.resourceVersion,
      initialTarget.metadata.resourceVersion,
    );
    assert.equal(
      target.metadata.annotations['qinglong.io/worker-credential-delivery-id'],
      winner.deliveryId,
    );
    const deployment = await deployments.readNamespacedDeployment({
      namespace,
      name: 'integration-worker',
    });
    assert.equal(
      deployment.spec.template.metadata.annotations[
        'qinglong.io/worker-credential-generation'
      ],
      winner.deploymentGeneration,
    );

    const orphan = token('integration_orphan', 4);
    const orphanIntent = intent(
      adapter,
      IDS[3],
      'integration_orphan',
      orphan,
    );
    await adapter.stage(orphanIntent, orphan);
    await adapter.discard(orphanIntent);
    assert.equal(await adapter.inspect(orphanIntent.deliveryId), null);
    const page = await adapter.listStaged({ limit: 4 });
    assert.equal(page.stages.some((item) =>
      item.deliveryId === orphanIntent.deliveryId), false);

    first.fill(0);
    second.fill(0);
    third.fill(0);
    orphan.fill(0);
  },
);
