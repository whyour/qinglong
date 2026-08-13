#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  K3sDockerLiveFixture,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');

const ROOT = path.resolve(__dirname, '..');
const ACTOR_FILE = path.join(
  __dirname,
  'ql3-plugin-package-kubernetes-live-actor.cjs',
);
const RESULT_SCHEMA = 'qinglong/plugin-package-kubernetes-live-actor-result@v1';
const NAMESPACE = 'ql3-plugin-package-live';
const SERVICE_ACCOUNT = 'ql3-plugin-package-recovery-live';
const IMAGE = 'qinglong3-cluster-admin:ql3-k3s-kubernetes-live';
const WORKLOAD = 'ql3-plugin-package-workload-live';
const SECRET_ROOT = '/var/run/secrets/qinglong3/plugin-package-values';
const WORKLOAD_REPLICAS = 2;
const SECRET_MARKER = 'ql3-live-exact-projection';
let renderWorkloadVolume = null;

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(binary)} failed with ${String(result.status)}: ` +
        `${result.stderr || result.stdout || ''}`,
    );
  }
  return result;
}

function roleDocuments() {
  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NAMESPACE },
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE },
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'create', 'update'],
        },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: SERVICE_ACCOUNT,
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: SERVICE_ACCOUNT,
          namespace: NAMESPACE,
        },
      ],
    },
  ];
}

function actorPod(actor) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `ql3-plugin-package-live-${actor}`,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/name': 'ql3-plugin-package-live',
        'qinglong.io/live-actor': actor,
      },
    },
    spec: {
      serviceAccountName: SERVICE_ACCOUNT,
      automountServiceAccountToken: true,
      restartPolicy: 'Never',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'recovery',
          image: IMAGE,
          imagePullPolicy: 'Never',
          command: ['node', '/opt/ql3-live/actor.cjs'],
          env: [
            { name: 'NODE_PATH', value: '/opt/qinglong/node_modules' },
            { name: 'QL3_LIVE_NAMESPACE', value: NAMESPACE },
            { name: 'QL3_LIVE_ACTOR', value: actor },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            requests: { cpu: '25m', memory: '64Mi' },
            limits: { cpu: '500m', memory: '256Mi' },
          },
          volumeMounts: [
            { name: 'actor', mountPath: '/opt/ql3-live', readOnly: true },
          ],
        },
      ],
      volumes: [
        {
          name: 'actor',
          configMap: {
            name: 'ql3-plugin-package-live-actor',
            defaultMode: 0o444,
            items: [{ key: 'actor.cjs', path: 'actor.cjs' }],
          },
        },
      ],
    },
  };
}

async function actorResult(fixture, actor) {
  const pod = `ql3-plugin-package-live-${actor}`;
  const observed = await waitFor(`${pod} termination result`, 60_000, () => {
    const value = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pod', pod]);
    const terminated = value.status?.containerStatuses?.find(
      (container) => container.name === 'recovery',
    )?.state?.terminated;
    if (!terminated) {
      return { ready: false, fact: value.status?.phase ?? 'unknown' };
    }
    if (terminated.exitCode !== 0) {
      throw new Error(
        `${pod} exited ${terminated.exitCode}: ${terminated.message ?? ''}`,
      );
    }
    return { ready: true, value: terminated.message };
  });
  const value = JSON.parse(observed.value);
  assert.equal(value.schema, RESULT_SCHEMA);
  assert.equal(value.actor, actor);
  assert.equal(value.error, undefined);
  return value;
}

function activePointer(fixture) {
  const pointers = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'configmaps',
    '-l',
    'qinglong.io/plugin-package-active=v3',
  ]).items;
  assert.equal(pointers.length, 1);
  const pointer = JSON.parse(pointers[0].data['active.json']);
  assert.equal(
    pointer.schema,
    'qinglong/plugin-package-kubernetes-active-pointer@v3',
  );
  return Object.freeze({ configMap: pointers[0], pointer });
}

function sourceSecret(projection) {
  assert.equal(projection.items.length, 1);
  const projected = projection.items[0].key;
  const decoy = projected === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  return Object.freeze({
    decoy,
    document: {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      immutable: true,
      metadata: {
        name: projection.sourceSecretName,
        namespace: NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'qinglong3-live-gate',
          'qinglong.io/live-gate-role': 'projection-source',
        },
      },
      data: {
        [projected]: Buffer.from(SECRET_MARKER, 'utf8').toString('base64'),
        [decoy]: Buffer.from('ql3-live-decoy', 'utf8').toString('base64'),
      },
    },
  });
}

function workloadDeployment(active) {
  const projection = active.pointer.secretProjection;
  assert.equal(typeof renderWorkloadVolume, 'function');
  const rendered = renderWorkloadVolume(projection);
  const labels = {
    'app.kubernetes.io/name': WORKLOAD,
    'app.kubernetes.io/component': 'plugin-package-workload',
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: WORKLOAD,
      namespace: NAMESPACE,
      labels,
    },
    spec: {
      replicas: WORKLOAD_REPLICAS,
      revisionHistoryLimit: 2,
      progressDeadlineSeconds: 60,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
      },
      selector: { matchLabels: labels },
      template: {
        metadata: {
          labels,
          annotations: {
            'qinglong.io/plugin-package-generation-digest':
              active.pointer.intent.resourceGeneration.generationDigest,
            'qinglong.io/plugin-package-lock-digest':
              active.pointer.intent.lockDigest,
            'qinglong.io/plugin-package-secret-projection-digest':
              projection?.projectionDigest ?? 'none',
          },
        },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          affinity: {
            podAntiAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                {
                  labelSelector: { matchLabels: labels },
                  topologyKey: 'kubernetes.io/hostname',
                },
              ],
            },
          },
          containers: [
            {
              name: 'workload',
              image: IMAGE,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '-e',
                'setInterval(() => {}, 2147483647)',
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '250m', memory: '128Mi' },
              },
              ...(rendered
                ? { volumeMounts: [rendered.volumeMount] }
                : {}),
            },
          ],
          ...(rendered ? { volumes: [rendered.volume] } : {}),
        },
      },
    },
  };
}

async function workloadReady(fixture, active, minimumGeneration = 1) {
  const expectedLockDigest = active.pointer.intent.lockDigest;
  const expectedProjectionDigest =
    active.pointer.secretProjection?.projectionDigest ?? 'none';
  const observed = await waitFor(
    `Deployment/${WORKLOAD} rollout`,
    120_000,
    () => {
      const deployment = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'deployment',
        WORKLOAD,
      ]);
      const pods = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/name=${WORKLOAD}`,
      ]).items;
      const currentPods = pods.filter(
        (pod) =>
          pod.metadata?.annotations?.[
            'qinglong.io/plugin-package-lock-digest'
          ] === expectedLockDigest &&
          pod.metadata?.annotations?.[
            'qinglong.io/plugin-package-secret-projection-digest'
          ] === expectedProjectionDigest &&
          pod.status?.phase === 'Running' &&
          pod.status?.conditions?.some(
            (condition) =>
              condition.type === 'Ready' && condition.status === 'True',
          ),
      );
      const generation = deployment.metadata?.generation ?? 0;
      const ready =
        generation >= minimumGeneration &&
        deployment.status?.observedGeneration === generation &&
        deployment.status?.updatedReplicas === WORKLOAD_REPLICAS &&
        deployment.status?.readyReplicas === WORKLOAD_REPLICAS &&
        deployment.status?.availableReplicas === WORKLOAD_REPLICAS &&
        currentPods.length === WORKLOAD_REPLICAS &&
        new Set(currentPods.map((pod) => pod.spec?.nodeName)).size ===
          WORKLOAD_REPLICAS;
      return ready
        ? { ready: true, value: { deployment, pods: currentPods } }
        : {
            ready: false,
            fact: JSON.stringify({
              generation,
              observedGeneration: deployment.status?.observedGeneration,
              updatedReplicas: deployment.status?.updatedReplicas,
              readyReplicas: deployment.status?.readyReplicas,
              availableReplicas: deployment.status?.availableReplicas,
              currentPods: currentPods.length,
            }),
          };
    },
  );
  return observed.value;
}

function inspectWorkloadPod(fixture, pod, expectedPath) {
  const source = expectedPath
    ? `
      const fs = require('node:fs');
      const root = ${JSON.stringify(SECRET_ROOT)};
      const expected = ${JSON.stringify(expectedPath)};
      const files = fs.readdirSync(root).filter((name) => !name.startsWith('..')).sort();
      const value = fs.readFileSync(root + '/' + expected, 'utf8');
      const mode = fs.statSync(root + '/' + expected).mode & 0o777;
      process.stdout.write(JSON.stringify({ files, valueMatches: value === ${JSON.stringify(SECRET_MARKER)}, mode }));
    `
    : `
      const fs = require('node:fs');
      process.stdout.write(JSON.stringify({ rootAbsent: !fs.existsSync(${JSON.stringify(SECRET_ROOT)}) }));
    `;
  return JSON.parse(
    fixture.kubectl(
      ['-n', NAMESPACE, 'exec', pod.metadata.name, '--', 'node', '-e', source],
      { capture: true, quiet: true },
    ).stdout,
  );
}

async function main() {
  if (process.env.QL3_PLUGIN_PACKAGE_K3S_LIVE !== '1') {
    throw new Error('refusing to run without QL3_PLUGIN_PACKAGE_K3S_LIVE=1');
  }
  ({
    pluginPackageKubernetesProjectedSecretWorkloadVolume: renderWorkloadVolume,
  } = require('../packages/ql3-cluster-admin/dist/plugin-package/recovery/pluginPackageKubernetesActivation.js'));
  const fixture = new K3sDockerLiveFixture({
    prefix: 'ql3-plugin-v3-live',
    kubectl:
      process.env.QL3_KUBECTL_BIN ??
      '/Applications/Docker.app/Contents/Resources/bin/kubectl',
  });
  const startedAt = Date.now();
  try {
    run('docker', [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag',
      IMAGE,
      '--build-arg',
      `SOURCE_REVISION=${process.env.GITHUB_SHA ?? 'local-k3s-live-contract'}`,
      '.',
    ]);
    const nodes = await fixture.start();
    fixture.loadImage(IMAGE, 'plugin-package-v3-admin.tar');
    for (const document of roleDocuments()) fixture.apply(document);
    fixture.apply({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-plugin-package-live-actor',
        namespace: NAMESPACE,
      },
      data: { 'actor.cjs': fs.readFileSync(ACTOR_FILE, 'utf8') },
    });
    fixture.apply(actorPod('a'));
    fixture.apply(actorPod('b'));
    await waitFor('two v3 projection CAS actors', 180_000, () => {
      const pods = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=ql3-plugin-package-live',
      ]).items;
      const failed = pods.find((pod) => pod.status.phase === 'Failed');
      if (failed) {
        const logs = fixture.kubectl(
          ['-n', NAMESPACE, 'logs', failed.metadata.name],
          { capture: true, quiet: true, allowFailure: true },
        );
        throw new Error(logs.stderr || logs.stdout);
      }
      return pods.length === 2 &&
        pods.every((pod) => pod.status.phase === 'Succeeded')
        ? { ready: true, value: pods }
        : {
            ready: false,
            fact: pods.map((pod) => `${pod.metadata.name}:${pod.status.phase}`),
          };
    });

    const actors = await Promise.all([
      actorResult(fixture, 'a'),
      actorResult(fixture, 'b'),
    ]);
    const winner = actors.find((actor) => actor.cas.status === 'fulfilled');
    const loser = actors.find((actor) => actor.cas.status === 'conflict');
    assert.ok(winner);
    assert.ok(loser);
    assert.equal(winner.final.pointerSchema.endsWith('@v3'), true);
    assert.equal(winner.final.projectionItemCount, 1);
    assert.equal(winner.final.projectedWorkloadVolume, true);
    assert.equal(winner.final.projectionDigest, loser.final.projectionDigest);
    assert.equal(
      winner.final.transitionReceiptDigest,
      loser.final.transitionReceiptDigest,
    );
    assert.deepEqual(winner.rbac, {
      listConfigMaps: 403,
      deleteConfigMap: 403,
      readSecret: 403,
      crossNamespaceRead: 403,
    });
    assert.deepEqual(loser.rbac, winner.rbac);
    const rotated = activePointer(fixture);
    const projectedPath = rotated.pointer.secretProjection.items[0].path;
    const secret = sourceSecret(rotated.pointer.secretProjection);
    fixture.apply(secret.document);
    fixture.apply(workloadDeployment(rotated));
    const mounted = await workloadReady(fixture, rotated);
    const mountedInspection = mounted.pods.map((pod) =>
      inspectWorkloadPod(fixture, pod, projectedPath),
    );
    for (const inspection of mountedInspection) {
      assert.deepEqual(inspection.files, [projectedPath]);
      assert.equal(inspection.valueMatches, true);
      assert.equal(inspection.mode, 0o440);
      assert.equal(inspection.files.includes(secret.decoy), false);
    }

    fixture.apply(actorPod('c'));
    const revoker = await actorResult(fixture, 'c');
    assert.equal(revoker.mode, 'revoke');
    assert.equal(revoker.cas.status, 'fulfilled');
    assert.equal(revoker.final.pointerSchema.endsWith('@v3'), true);
    assert.equal(revoker.final.projectionItemCount, 0);
    assert.equal(revoker.final.projectedWorkloadVolume, false);
    assert.deepEqual(revoker.rbac, winner.rbac);
    const revoked = activePointer(fixture);
    assert.equal(revoked.pointer.secretProjection.items.length, 0);
    assert.equal(
      revoked.pointer.secretProjection.transitionReceiptDigest,
      revoker.final.transitionReceiptDigest,
    );
    fixture.apply(workloadDeployment(revoked));
    const unmounted = await workloadReady(
      fixture,
      revoked,
      (mounted.deployment.metadata?.generation ?? 1) + 1,
    );
    assert.equal(
      unmounted.pods.some((pod) =>
        mounted.pods.some((old) => old.metadata.uid === pod.metadata.uid),
      ),
      false,
    );
    const revokedInspection = unmounted.pods.map((pod) =>
      inspectWorkloadPod(fixture, pod, null),
    );
    assert.equal(
      revokedInspection.every((inspection) => inspection.rootAbsent === true),
      true,
    );
    const retainedSource = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      rotated.pointer.secretProjection.sourceSecretName,
    ]);
    assert.equal(Object.keys(retainedSource.data).length, 2);
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fixture: 'qinglong/plugin-package-kubernetes-k3s-live@v1',
          platform: {
            kubernetesVersion: fixture.kubectlJson(['version']).serverVersion
              .gitVersion,
            nodeCount: nodes.length,
          },
          result: {
            fulfilled: 1,
            conflicts: 1,
            pointerSchema: winner.final.pointerSchema,
            projectionDigest: winner.final.projectionDigest,
            transitionReceiptDigest: winner.final.transitionReceiptDigest,
            exactProjectionItems: winner.final.projectionItemCount,
            secretApiReadDenied: winner.rbac.readSecret === 403,
            activePointers: 1,
            workloadReplicas: WORKLOAD_REPLICAS,
            workloadNodes: new Set(
              unmounted.pods.map((pod) => pod.spec.nodeName),
            ).size,
            revokeProjectionItems:
              revoked.pointer.secretProjection.items.length,
            revokeTransitionReceiptDigest:
              revoker.final.transitionReceiptDigest,
          },
          gates: {
            realThreeNodeKubernetes: true,
            resourceVersionSingleWinner: true,
            v3TransitionReceiptBound: true,
            exactSecretProjectionRendered: true,
            secretApiReadDenied: true,
            exactItemMountedByRealWorkload: true,
            unprojectedSecretKeyAbsent: true,
            workloadReplicasOnDistinctNodes: true,
            revokeReceiptBound: true,
            revokeRolledNewPods: true,
            revokedWorkloadHasNoSecretMount: true,
            sourceSecretRetainedButInaccessible: true,
            passed: true,
          },
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await fixture.cleanup();
  }
}

main().catch((error) => {
  process.stderr.write(
    `QL3 Plugin Package K3s v3 live contract failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
