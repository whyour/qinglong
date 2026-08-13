'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '../..');
const hostFile = path.join(
  root,
  'scripts/ql3-plugin-package-kubernetes-live-contract.cjs',
);
const actorFile = path.join(
  root,
  'scripts/ql3-plugin-package-kubernetes-live-actor.cjs',
);
const k3sHostFile = path.join(
  root,
  'scripts/ql3-plugin-package-kubernetes-k3s-live-contract.cjs',
);
const hostSource = fs.readFileSync(hostFile, 'utf8');
const actorSource = fs.readFileSync(actorFile, 'utf8');
const k3sHostSource = fs.readFileSync(k3sHostFile, 'utf8');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const workflow = yaml.load(
  fs.readFileSync(path.join(root, '.github/workflows/ql3-ci.yml'), 'utf8'),
);

test('live contract is explicit opt-in and owns an exact disposable cluster', () => {
  const result = spawnSync(process.execPath, [hostFile], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /refusing to run without QL3_PLUGIN_PACKAGE_KUBERNETES_LIVE=1/,
  );
  assert.match(hostSource, /kind create isolated cluster/);
  assert.match(hostSource, /kind delete exact cluster/);
  assert.doesNotMatch(hostSource, /QL3_REUSE_KIND_CLUSTER/);
  assert.match(hostSource, /kindest\/node:v1\.32\.8@sha256:[0-9a-f]{64}/);
  assert.match(hostSource, /NO_PROXY: noProxy/);
  assert.match(hostSource, /no_proxy: noProxy/);
});

test('two non-root actors use the admin image and real projected tokens', () => {
  assert.match(hostSource, /actorPod\('a', image\)/);
  assert.match(hostSource, /actorPod\('b', image\)/);
  assert.match(hostSource, /serviceAccountName: SERVICE_ACCOUNT/);
  assert.match(hostSource, /automountServiceAccountToken: true/);
  assert.match(hostSource, /runAsNonRoot: true/);
  assert.match(hostSource, /readOnlyRootFilesystem: true/);
  assert.match(hostSource, /capabilities: \{ drop: \['ALL'\] \}/);
  assert.match(
    actorSource,
    /\/var\/run\/secrets\/kubernetes\.io\/serviceaccount\/token/,
  );
  assert.match(actorSource, /kubeConfig\.loadFromCluster\(\)/);
});

test('live actors fence the same resourceVersion and recover one lost create response', () => {
  assert.match(
    actorSource,
    /injected response loss after Kubernetes API-confirmed create/,
  );
  assert.match(actorSource, /initialPublisher\.inspect\(initial\)/);
  assert.match(actorSource, /publisher\.publish\(candidate\)/);
  assert.match(actorSource, /finalPointer\.schema\.endsWith\('@v3'\)/);
  assert.match(actorSource, /finalPointer\.secretProjection\.items/);
  assert.match(actorSource, /assert\.equal\(createCalls, 1\)/);
  assert.match(actorSource, /ql3-live-cas-ready-\$\{ACTOR\}/);
  assert.match(hostSource, /sameResourceVersionAttemptedByBothPods: true/);
  assert.match(hostSource, /concurrentReplacementSingleWinner: true/);
  assert.match(hostSource, /activePointers\.length, 1/);
  assert.match(hostSource, /not by dropping raw network packets/);
});

test('the ServiceAccount has only ConfigMap get, create and update', () => {
  assert.match(
    hostSource,
    /resources: \['configmaps'\],[\s\S]*verbs: \['get', 'create', 'update'\]/,
  );
  assert.match(actorSource, /listNamespacedConfigMap/);
  assert.match(actorSource, /deleteNamespacedConfigMap/);
  assert.match(actorSource, /readNamespacedSecret/);
  assert.match(actorSource, /namespace: 'default'/);
  assert.match(hostSource, /configMapListDeleteDenied: true/);
  assert.match(hostSource, /secretReadCreateDenied: true/);
  assert.match(hostSource, /crossNamespaceReadDenied: true/);
});

test('CI runs the dedicated live gate without reusing another cluster', () => {
  assert.equal(
    packageJson.scripts['test:plugin-package-kubernetes-live:ql3'],
    'node scripts/ql3-plugin-package-kubernetes-live-contract.cjs',
  );
  const job = workflow.jobs['cluster-plugin-package-kubernetes-live'];
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 20);
  const liveStep = job.steps.find(
    (step) => step.run === 'pnpm test:plugin-package-kubernetes-live:ql3',
  );
  assert.deepEqual(liveStep.env, {
    QL3_PLUGIN_PACKAGE_KUBERNETES_LIVE: '1',
    QL3_KIND_BIN: '${{ github.workspace }}/kind-linux-amd64',
    QL3_KUBECTL_BIN: '${{ github.workspace }}/kubectl',
    QL3_KIND_CLUSTER: 'ql3-plugin-activation-ci',
  });
  assert.equal(liveStep.env.QL3_REUSE_KIND_CLUSTER, undefined);
});

test('three-node K3s gate proves exact workload projection and receipt-bound revoke', () => {
  const result = spawnSync(process.execPath, [k3sHostFile], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /refusing to run without QL3_PLUGIN_PACKAGE_K3S_LIVE=1/,
  );
  assert.equal(
    packageJson.scripts['test:plugin-package-kubernetes-k3s-live:ql3'],
    'pnpm --filter @qinglong/cluster-admin build && node scripts/ql3-plugin-package-kubernetes-k3s-live-contract.cjs',
  );
  assert.match(k3sHostSource, /fixture\.apply\(actorPod\('c'\)\)/);
  assert.match(k3sHostSource, /maxUnavailable: 0, maxSurge: 1/);
  assert.match(k3sHostSource, /requiredDuringSchedulingIgnoredDuringExecution/);
  assert.match(k3sHostSource, /sourceSecret\(rotated\.pointer\.secretProjection\)/);
  assert.match(k3sHostSource, /assert\.deepEqual\(inspection\.files, \[projectedPath\]\)/);
  assert.match(k3sHostSource, /revokedWorkloadHasNoSecretMount: true/);
  assert.match(k3sHostSource, /sourceSecretRetainedButInaccessible: true/);
  assert.match(actorSource, /mode: 'revoke'/);
  assert.match(actorSource, /active\.secretProjection\.items\.length, 0/);
  assert.match(
    actorSource,
    /pluginPackageKubernetesProjectedSecretWorkloadVolume\([\s\S]*active\.secretProjection/,
  );
});
