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

async function main() {
  if (process.env.QL3_PLUGIN_PACKAGE_K3S_LIVE !== '1') {
    throw new Error('refusing to run without QL3_PLUGIN_PACKAGE_K3S_LIVE=1');
  }
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
    const pointers = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'configmaps',
      '-l',
      'qinglong.io/plugin-package-active=v3',
    ]).items;
    assert.equal(pointers.length, 1);
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
            activePointers: pointers.length,
          },
          gates: {
            realThreeNodeKubernetes: true,
            resourceVersionSingleWinner: true,
            v3TransitionReceiptBound: true,
            exactSecretProjectionRendered: true,
            secretApiReadDenied: true,
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
