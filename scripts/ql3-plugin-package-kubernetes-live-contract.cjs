#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ACTOR_FILE = path.join(
  __dirname,
  'ql3-plugin-package-kubernetes-live-actor.cjs',
);
const RESULT_SCHEMA = 'qinglong/plugin-package-kubernetes-live-actor-result@v1';
const REPORT_FIXTURE = 'qinglong/plugin-package-kubernetes-live-contract@v1';
const NAMESPACE = 'ql3-plugin-package-live';
const SERVICE_ACCOUNT = 'ql3-plugin-package-recovery-live';
const KIND_NODE_IMAGE =
  'kindest/node:v1.32.8@sha256:abd489f042d2b644e2d033f5c2d900bc707798d075e8186cb65e3f1367a9d5a1';
const DEFAULT_IMAGE = 'qinglong3-cluster-admin:ql3-kubernetes-live';
const SAFE_CLUSTER =
  /^ql3-plugin-activation(?:-[a-z0-9](?:[-a-z0-9]{0,30}[a-z0-9])?)?$/;

function fail(message) {
  throw new Error(message);
}

function executable(environmentName, fallback) {
  return process.env[environmentName] || fallback;
}

const KIND = executable('QL3_KIND_BIN', 'kind');
const KUBECTL = executable('QL3_KUBECTL_BIN', 'kubectl');
const DOCKER = executable('QL3_DOCKER_BIN', 'docker');

function commandLabel(binary, args) {
  return [path.basename(binary), ...args].join(' ');
}

function run(binary, args, options = {}) {
  if (!options.quiet) {
    process.stderr.write(`+ ${options.label || commandLabel(binary, args)}\n`);
  }
  const capture = options.capture === true;
  const result = spawnSync(binary, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture
      ? ['pipe', 'pipe', 'pipe']
      : [
          options.input === undefined ? 'inherit' : 'pipe',
          'inherit',
          'inherit',
        ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = capture ? `\n${result.stderr || result.stdout || ''}` : '';
    fail(
      `${path.basename(binary)} exited with status ${String(
        result.status,
      )}${detail}`,
    );
  }
  return Object.freeze({
    status: result.status,
    stdout: capture ? result.stdout.trim() : '',
    stderr: capture ? result.stderr.trim() : '',
  });
}

function kind(args, options) {
  return run(KIND, args, options);
}

let kubeconfig = '';

function kubectl(args, options = {}) {
  return run(KUBECTL, ['--kubeconfig', kubeconfig, ...args], options);
}

function kubectlJson(args) {
  const output = kubectl([...args, '-o', 'json'], {
    capture: true,
    quiet: true,
  }).stdout;
  return JSON.parse(output);
}

function apply(body, label) {
  kubectl(['apply', '-f', '-'], {
    input: `${JSON.stringify(body)}\n`,
    label,
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, inspect) {
  const startedAt = Date.now();
  let lastFact = 'not observed';
  while (Date.now() - startedAt < timeoutMs) {
    let result;
    try {
      result = inspect();
      if (result?.ready) {
        return {
          elapsedMs: Date.now() - startedAt,
          value: result.value,
        };
      }
      if (result?.fact) lastFact = result.fact;
    } catch (error) {
      lastFact = error instanceof Error ? error.message : String(error);
    }
    if (result?.fatal) {
      fail(`${description} failed: ${result.fatal}`);
    }
    await sleep(1_000);
  }
  fail(`${description} timed out after ${timeoutMs}ms: ${lastFact}`);
}

function exactClusterName() {
  const configured =
    process.env.QL3_KIND_CLUSTER ??
    `ql3-plugin-activation-${process.pid.toString(36)}`;
  if (!SAFE_CLUSTER.test(configured)) {
    fail(
      'QL3_KIND_CLUSTER must be an exact ql3-plugin-activation[-suffix] name',
    );
  }
  return configured;
}

function kindCreateEnvironment(clusterName) {
  const required = [
    '127.0.0.1',
    'localhost',
    `${clusterName}-control-plane`,
    '.svc',
    '.cluster.local',
    '10.96.0.0/12',
    '10.244.0.0/16',
    '172.16.0.0/12',
  ];
  const configured = [process.env.NO_PROXY, process.env.no_proxy, ...required]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const noProxy = [...new Set(configured)].join(',');
  return {
    ...process.env,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
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

function actorPod(actor, image) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `ql3-plugin-package-live-${actor}`,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/name': 'ql3-plugin-package-live',
        'app.kubernetes.io/component': 'plugin-package-recovery',
        'app.kubernetes.io/part-of': 'qinglong3',
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
          image,
          imagePullPolicy: 'Never',
          command: ['node', '/opt/ql3-live/actor.cjs'],
          env: [
            {
              name: 'NODE_PATH',
              value: '/opt/qinglong/node_modules',
            },
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
            {
              name: 'actor',
              mountPath: '/opt/ql3-live',
              readOnly: true,
            },
          ],
        },
      ],
      volumes: [
        {
          name: 'actor',
          configMap: {
            name: 'ql3-plugin-package-live-actor',
            defaultMode: 292,
            items: [{ key: 'actor.cjs', path: 'actor.cjs' }],
          },
        },
      ],
    },
  };
}

function canI(verb, resource, options = {}) {
  const namespace = options.namespace ?? NAMESPACE;
  const result = kubectl(
    [
      'auth',
      'can-i',
      verb,
      resource,
      '--namespace',
      namespace,
      '--as',
      `system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}`,
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  assert.ok(result.status === 0 || result.status === 1);
  assert.ok(result.stdout === 'yes' || result.stdout === 'no');
  return result.stdout === 'yes';
}

function actorResult(actor) {
  const podName = `ql3-plugin-package-live-${actor}`;
  const output = kubectl(['-n', NAMESPACE, 'logs', podName, '-c', 'recovery'], {
    capture: true,
    quiet: true,
  }).stdout;
  const line = output
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1);
  assert.ok(line, `${podName} emitted no result`);
  const result = JSON.parse(line);
  assert.equal(result.schema, RESULT_SCHEMA);
  assert.equal(result.actor, actor);
  assert.equal(result.error, undefined);
  return result;
}

async function main() {
  if (process.env.QL3_PLUGIN_PACKAGE_KUBERNETES_LIVE !== '1') {
    fail('refusing to run without QL3_PLUGIN_PACKAGE_KUBERNETES_LIVE=1');
  }
  run(DOCKER, ['version'], { capture: true, quiet: true });
  run(KIND, ['version'], { capture: true, quiet: true });
  run(KUBECTL, ['version', '--client=true'], {
    capture: true,
    quiet: true,
  });

  const clusterName = exactClusterName();
  const image =
    process.env.QL3_PLUGIN_PACKAGE_KUBERNETES_IMAGE ?? DEFAULT_IMAGE;
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,255}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
      image,
    )
  ) {
    fail('QL3_PLUGIN_PACKAGE_KUBERNETES_IMAGE must be an exact local tag');
  }
  const existingClusters = kind(['get', 'clusters'], {
    capture: true,
    quiet: true,
    allowFailure: true,
  })
    .stdout.split('\n')
    .filter(Boolean);
  if (existingClusters.includes(clusterName)) {
    fail(`refusing to reuse or delete existing Kind cluster ${clusterName}`);
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-plugin-kubernetes-live-'),
  );
  kubeconfig = path.join(temporaryDirectory, 'kubeconfig');
  let clusterCreated = false;
  const startedAt = Date.now();
  try {
    if (process.env.QL3_PLUGIN_PACKAGE_KUBERNETES_BUILD_IMAGE !== '0') {
      run(
        DOCKER,
        [
          'build',
          '--file',
          'deploy/containers/ql3-cluster-admin/Dockerfile',
          '--tag',
          image,
          '--build-arg',
          `SOURCE_REVISION=${process.env.GITHUB_SHA ?? 'local-live-contract'}`,
          '.',
        ],
        { label: `docker build ${image}` },
      );
    } else {
      run(DOCKER, ['image', 'inspect', image], {
        capture: true,
        quiet: true,
      });
    }

    kind(
      [
        'create',
        'cluster',
        '--name',
        clusterName,
        '--image',
        KIND_NODE_IMAGE,
        '--kubeconfig',
        kubeconfig,
        '--wait',
        '120s',
      ],
      {
        label: `kind create isolated cluster ${clusterName}`,
        env: kindCreateEnvironment(clusterName),
      },
    );
    clusterCreated = true;
    kind(['load', 'docker-image', '--name', clusterName, image]);

    for (const document of roleDocuments()) {
      apply(
        document,
        `kubectl apply ${document.kind}/${document.metadata.name}`,
      );
    }
    apply(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'ql3-plugin-package-live-actor',
          namespace: NAMESPACE,
        },
        data: { 'actor.cjs': fs.readFileSync(ACTOR_FILE, 'utf8') },
      },
      'kubectl apply ConfigMap/ql3-plugin-package-live-actor',
    );
    apply(actorPod('a', image), 'kubectl apply Pod/ql3-plugin-package-live-a');
    apply(actorPod('b', image), 'kubectl apply Pod/ql3-plugin-package-live-b');

    const completion = await waitFor(
      'both restricted recovery Pods',
      120_000,
      () => {
        const pods = kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'pods',
          '-l',
          'app.kubernetes.io/name=ql3-plugin-package-live',
        ]).items;
        const facts = Object.fromEntries(
          pods.map((pod) => [pod.metadata.name, pod.status.phase]),
        );
        const failed = pods.find((pod) => pod.status.phase === 'Failed');
        if (failed) {
          const logs = kubectl(
            ['-n', NAMESPACE, 'logs', failed.metadata.name],
            { capture: true, quiet: true, allowFailure: true },
          );
          return {
            ready: false,
            fatal: `${failed.metadata.name}: ${logs.stderr || logs.stdout}`,
          };
        }
        return {
          ready:
            pods.length === 2 &&
            pods.every((pod) => pod.status.phase === 'Succeeded'),
          value: facts,
          fact: JSON.stringify(facts),
        };
      },
    );

    const actors = [actorResult('a'), actorResult('b')];
    assert.equal(
      actors.filter((actor) => actor.cas.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      actors.filter((actor) => actor.cas.status === 'conflict').length,
      1,
    );
    assert.ok(
      actors.every(
        (actor) =>
          actor.serviceAccountTokenMounted === true &&
          actor.cas.replaceCalls === 1 &&
          /^[1-9][0-9]*$/.test(actor.cas.attemptedResourceVersion),
      ),
    );
    assert.equal(
      new Set(actors.map((actor) => actor.cas.attemptedResourceVersion)).size,
      1,
      'both recovery Pods must attempt the same resourceVersion',
    );
    assert.deepEqual(actors[0].rbac, {
      listConfigMaps: 403,
      deleteConfigMap: 403,
      readSecret: 403,
      crossNamespaceRead: 403,
    });
    assert.deepEqual(actors[1].rbac, actors[0].rbac);
    assert.deepEqual(actors[0].responseLoss, {
      injectedAfterApiConfirmedCreate: true,
      firstCallFailedClosed: true,
      durableInspectPublished: true,
      replayReturnedExactReceipt: true,
      createCalls: 1,
      nowCalls: 1,
    });
    assert.equal(actors[1].responseLoss, null);

    const winner = actors.find((actor) => actor.cas.status === 'fulfilled');
    const loser = actors.find((actor) => actor.cas.status === 'conflict');
    assert.equal(winner.final.lockDigest, loser.final.lockDigest);
    assert.equal(
      winner.final.lockDigest,
      winner.actor === 'a' ? '1'.repeat(64) : '6'.repeat(64),
    );
    assert.equal(winner.final.generation, 2);
    assert.equal(winner.final.resourceVersion, loser.final.resourceVersion);

    const activePointers = kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'configmaps',
      '-l',
      'qinglong.io/plugin-package-active=v2',
    ]).items;
    assert.equal(activePointers.length, 1);
    const barriers = kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'configmaps',
      '-l',
      'qinglong.io/live-gate-role=cas-barrier',
    ]).items;
    assert.equal(barriers.length, 2);
    const secrets = kubectlJson(['-n', NAMESPACE, 'get', 'secrets']).items;
    assert.equal(secrets.length, 0);

    const rbac = Object.freeze({
      getConfigMaps: canI('get', 'configmaps'),
      createConfigMaps: canI('create', 'configmaps'),
      updateConfigMaps: canI('update', 'configmaps'),
      listConfigMaps: canI('list', 'configmaps'),
      deleteConfigMaps: canI('delete', 'configmaps'),
      getSecrets: canI('get', 'secrets'),
      createSecrets: canI('create', 'secrets'),
      crossNamespaceGetConfigMaps: canI('get', 'configmaps', {
        namespace: 'default',
      }),
    });
    assert.deepEqual(rbac, {
      getConfigMaps: true,
      createConfigMaps: true,
      updateConfigMaps: true,
      listConfigMaps: false,
      deleteConfigMaps: false,
      getSecrets: false,
      createSecrets: false,
      crossNamespaceGetConfigMaps: false,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fixture: REPORT_FIXTURE,
          cluster: {
            kindName: clusterName,
            nodeImage: KIND_NODE_IMAGE,
            namespace: NAMESPACE,
            image,
          },
          recoveryPods: {
            count: 2,
            completionMs: completion.elapsedMs,
            serviceAccountTokenMounted: true,
            distinctProcesses: true,
          },
          responseLoss: {
            scope:
              'client boundary after Kubernetes API-confirmed create; not raw-wire packet loss',
            createCalls: actors[0].responseLoss.createCalls,
            durableInspectPublished: true,
            exactReplayWithoutRepublish: true,
          },
          resourceVersionCas: {
            attemptedResourceVersion: winner.cas.attemptedResourceVersion,
            fulfilled: 1,
            conflicts: 1,
            finalResourceVersion: winner.final.resourceVersion,
            winner: winner.actor,
            activePointers: activePointers.length,
          },
          rbac,
          sideEffects: {
            activePointers: activePointers.length,
            casBarriers: barriers.length,
            secrets: secrets.length,
          },
          gates: {
            realKubernetesApi: true,
            realProjectedServiceAccountTokens: true,
            twoRestrictedRecoveryPods: true,
            apiConfirmedCreateResponseLossFailedClosed: true,
            durableInspectRecoveredPublication: true,
            exactReplayDidNotRepublish: true,
            sameResourceVersionAttemptedByBothPods: true,
            concurrentReplacementSingleWinner: true,
            loserObservedConflict: true,
            finalPointerExactlyOne: true,
            configMapGetCreateUpdateAllowed: true,
            configMapListDeleteDenied: true,
            secretReadCreateDenied: true,
            crossNamespaceReadDenied: true,
            passed: true,
          },
          elapsedMs: Date.now() - startedAt,
          limitations: [
            'response loss is injected after an API-confirmed create at the Kubernetes client boundary, not by dropping raw network packets',
            'single-control-plane Kind proves API-server resourceVersion and RBAC semantics, not Kubernetes control-plane HA',
            'the gate isolates ConfigMap publication authority and does not exercise PostgreSQL or OCI registry recovery',
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (
      clusterCreated &&
      process.env.QL3_KEEP_PLUGIN_PACKAGE_KUBERNETES_LIVE !== '1'
    ) {
      kind(['delete', 'cluster', '--name', clusterName], {
        label: `kind delete exact cluster ${clusterName}`,
      });
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `ql3 Plugin Package Kubernetes live contract failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
