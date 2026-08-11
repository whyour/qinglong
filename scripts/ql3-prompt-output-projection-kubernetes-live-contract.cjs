#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalPluginPackagePromptOutputKeyringManifest,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyringManifest.js');
const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputProjectionKubernetesLiveReport,
} = require('./ql3-prompt-output-projection-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const SERVICE_ACCOUNT = 'ql3-prompt-output-projection';
const POD = 'ql3-prompt-output-projection';
const SECRET_NAME = 'ql3-prompt-output-keyring';
const IMAGE_BASE = 'ql3-prompt-output-projection-live';
const PRESERVE_FAILURE_ENV =
  'QL3_PROMPT_OUTPUT_PROJECTION_KUBERNETES_LIVE_PRESERVE_FAILURE';

function imageId(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return image.Id;
}

function keyring(generation, activeKeyId, keys) {
  return Object.freeze({
    schema: 'qinglong/plugin-package-prompt-output-file-keyring@v1',
    generation,
    activeKeyId,
    keys: Object.freeze(keys),
    retirements: Object.freeze({}),
  });
}

function secretManifest(manifest, revision) {
  const bytes = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
  try {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: SECRET_NAME,
        namespace: NAMESPACE,
        ...(revision === undefined ? {} : { resourceVersion: revision }),
      },
      type: 'Opaque',
      immutable: false,
      data: { 'keyring.json': bytes.toString('base64') },
    };
  } finally {
    bytes.fill(0);
  }
}

function actorSource() {
  return String.raw`
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  createPluginPackagePromptOutputArtifact,
  openPluginPackagePromptOutputArtifact,
} = require('@qinglong/ai/plugin-package-prompt-output-artifact');
const {
  createPluginPackagePromptOutputProjectedKeyring,
} = require('@qinglong/ai/plugin-package-prompt-output-projected-keyring');

const root = '/var/run/secrets/qinglong3/ai/prompt-output-keyring';
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
let stage = 'create-provider';

async function main() {
  const provider = await createPluginPackagePromptOutputProjectedKeyring({
    rootDirectory: root,
  });
  const first = await provider.active();
  stage = 'create-artifact';
  const firstId = first.keyId;
  const expected = Object.freeze({
    provider: 'openai-compatible',
    model: 'projection-live-model',
    text: 'projection-live-private-result',
    finishReason: 'stop',
    usage: Object.freeze({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costMicros: 0,
    }),
  });
  const artifact = createPluginPackagePromptOutputArtifact({
    projectId: 'projection-live-project',
    runId: 'projection-live-run',
    stepRunId: 'projection-live-step',
    invocationId: 'projection-live-invocation',
    requestedBy: { type: 'system', id: 'projection-live' },
    result: expected,
    retentionPolicy: { revision: 'projection-live-v1', retentionMs: 3600000 },
    keyId: first.keyId,
    key: first.key,
    sealedAtMs: Date.now(),
  });
  first.key.fill(0);
  fs.writeFileSync('/tmp/projection-ready', 'ready\n', { flag: 'wx' });

  stage = 'wait-for-rotation';
  const deadline = Date.now() + 180000;
  let second;
  let transientUnavailableObserved = false;
  while (Date.now() < deadline) {
    let candidate;
    try {
      candidate = await provider.active();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        error.code === 'PLUGIN_PACKAGE_PROMPT_OUTPUT_PROJECTED_KEYRING_UNAVAILABLE'
      ) {
        transientUnavailableObserved = true;
        await sleep(250);
        continue;
      }
      throw error;
    }
    if (candidate.keyId !== firstId) {
      second = candidate;
      break;
    }
    candidate.key.fill(0);
    await sleep(250);
  }
  assert.ok(second, 'projected active key did not rotate');
  second.key.fill(0);
  stage = 'open-historical-artifact';
  const historical = await provider.resolve(firstId);
  assert.ok(historical, 'historical key is unavailable');
  const opened = openPluginPackagePromptOutputArtifact(
    artifact,
    historical.key,
  );
  historical.key.fill(0);
  assert.deepEqual(opened, expected);
  stage = 'verify-runtime-boundary';
  const projectedFile = fs.lstatSync(root + '/keyring.json');
  assert.equal(projectedFile.isSymbolicLink(), true);
  assert.equal(
    fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'),
    false,
  );
  fs.writeFileSync(
    '/dev/termination-log',
    JSON.stringify({
      activeChanged: true,
      atomicWriterSymlink: true,
      historicalArtifactOpened: true,
      runtimeCredentialAbsent: true,
      transientUnavailableObserved,
    }),
  );
}

main().catch((error) => {
  fs.writeFileSync(
    '/dev/termination-log',
    JSON.stringify({
      failed: true,
      stage,
      name: error instanceof Error ? error.name : 'UnknownError',
      code:
        error && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : null,
    }),
  );
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
`;
}

function projectionResources(image) {
  return [
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: POD,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/name': POD },
      },
      spec: {
        serviceAccountName: SERVICE_ACCOUNT,
        automountServiceAccountToken: false,
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
            name: 'projection-probe',
            image,
            imagePullPolicy: 'Never',
            command: ['node', '-e', actorSource()],
            readinessProbe: {
              exec: { command: ['test', '-f', '/tmp/projection-ready'] },
              periodSeconds: 1,
              timeoutSeconds: 1,
              failureThreshold: 180,
            },
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              limits: { cpu: '250m', memory: '128Mi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
            volumeMounts: [
              { name: 'tmp', mountPath: '/tmp' },
              {
                name: 'prompt-output-keyring',
                mountPath:
                  '/var/run/secrets/qinglong3/ai/prompt-output-keyring',
                readOnly: true,
              },
            ],
          },
        ],
        volumes: [
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
          {
            name: 'prompt-output-keyring',
            secret: {
              secretName: SECRET_NAME,
              defaultMode: 0o440,
              items: [{ key: 'keyring.json', path: 'keyring.json' }],
            },
          },
        ],
      },
    },
  ];
}

async function main() {
  if (process.env.QL3_PROMPT_OUTPUT_PROJECTION_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_PROMPT_OUTPUT_PROJECTION_KUBERNETES_LIVE=1',
    );
  }
  const fixture = new K3sDockerLiveFixture({
    prefix: 'ql3-key-projection-live',
  });
  const image = `${IMAGE_BASE}:${process.pid.toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  let imageBuilt = false;
  let completed = false;
  try {
    const nodes = await fixture.start();
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-control/Dockerfile',
      '--target',
      'runtime-ai',
      '--tag',
      image,
      '--build-arg',
      `SOURCE_REVISION=${process.env.GITHUB_SHA || 'live-contract'}`,
      '.',
    ]);
    imageBuilt = true;
    fixture.loadImage(image, 'prompt-output-projection.tar');
    fixture.kubectl([
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/namespace.yaml',
    ]);

    const firstId = 'projection-key-one';
    const secondId = 'projection-key-two';
    const firstValue = crypto.randomBytes(32).toString('base64url');
    const secondValue = crypto.randomBytes(32).toString('base64url');
    fixture.create(
      secretManifest(keyring(1, firstId, { [firstId]: firstValue })),
    );
    for (const resource of projectionResources(image)) fixture.create(resource);
    const readiness = await waitFor(
      'projection probe readiness',
      240_000,
      () => {
        const pod = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pod', POD]);
        const state = pod.status.containerStatuses?.[0]?.state;
        if (state?.terminated) {
          return { ready: true, value: { pod, terminated: state.terminated } };
        }
        return pod.status.conditions?.some(
          (condition) =>
            condition.type === 'Ready' && condition.status === 'True',
        )
          ? { ready: true, value: pod }
          : { ready: false, fact: pod.status.phase ?? 'Pending' };
      },
    );
    if (readiness.value.terminated) {
      throw new Error(
        `projection probe terminated before readiness: ${
          readiness.value.terminated.message ||
          readiness.value.terminated.reason
        }`,
      );
    }
    const podBefore = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pod', POD]);
    const secretBefore = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      SECRET_NAME,
    ]);
    fixture.kubectl(['replace', '-f', '-'], {
      input: `${JSON.stringify(
        secretManifest(
          keyring(2, secondId, {
            [firstId]: firstValue,
            [secondId]: secondValue,
          }),
          secretBefore.metadata.resourceVersion,
        ),
      )}\n`,
      capture: true,
      quiet: true,
    });
    const secretAfter = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      SECRET_NAME,
    ]);
    assert.notEqual(
      secretAfter.metadata.resourceVersion,
      secretBefore.metadata.resourceVersion,
    );

    const terminated = (
      await waitFor('projection probe completion', 240_000, () => {
        const pod = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pod', POD]);
        const state = pod.status.containerStatuses?.[0]?.state?.terminated;
        return state
          ? { ready: true, value: { pod, state } }
          : { ready: false, fact: pod.status.phase ?? 'Pending' };
      })
    ).value;
    assert.equal(terminated.state.exitCode, 0, terminated.state.message);
    const actor = JSON.parse(terminated.state.message);
    assert.equal(typeof actor.transientUnavailableObserved, 'boolean');
    assert.deepEqual(actor, {
      activeChanged: true,
      atomicWriterSymlink: true,
      historicalArtifactOpened: true,
      runtimeCredentialAbsent: true,
      transientUnavailableObserved: actor.transientUnavailableObserved,
    });
    const podSpec = terminated.pod.spec;
    const container = podSpec.containers[0];
    const projectionVolume = podSpec.volumes.find(
      (entry) => entry.name === 'prompt-output-keyring',
    );
    const projectionMount = container.volumeMounts.find(
      (entry) => entry.name === 'prompt-output-keyring',
    );
    assert.equal(podSpec.automountServiceAccountToken, false);
    assert.equal(projectionMount.readOnly, true);
    assert.equal(projectionVolume.secret.defaultMode, 0o440);
    assert.deepEqual(projectionVolume.secret.items, [
      { key: 'keyring.json', path: 'keyring.json' },
    ]);

    const version = fixture.kubectlJson(['version']).serverVersion.gitVersion;
    const report = Object.freeze({
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: Object.freeze({
        distribution: 'k3s',
        kubernetesVersion: version,
        architecture,
        kubernetesImageId: imageId(fixture.inspectImage(fixture.k3sImage)),
        cniName: 'flannel',
        controlPlaneNodes: nodes.filter(
          (node) =>
            node.metadata.labels?.['node-role.kubernetes.io/control-plane'] !==
            undefined,
        ).length,
        workerNodes: nodes.filter(
          (node) =>
            node.metadata.labels?.['node-role.kubernetes.io/control-plane'] ===
            undefined,
        ).length,
      }),
      projection: Object.freeze({
        generationBefore: 1,
        generationAfter: 2,
        defaultMode: 0o440,
        activeChanged: actor.activeChanged,
        atomicWriterSymlink: actor.atomicWriterSymlink,
        dataFileOnly: projectionVolume.secret.items.length === 1,
        historicalArtifactOpened: actor.historicalArtifactOpened,
        podIdentityStable:
          terminated.pod.metadata.uid === podBefore.metadata.uid,
        readOnlyMount: projectionMount.readOnly,
        revisionChanged:
          secretAfter.metadata.resourceVersion !==
          secretBefore.metadata.resourceVersion,
        runtimeCredentialAbsent: actor.runtimeCredentialAbsent,
        transientUnavailableObserved: actor.transientUnavailableObserved,
      }),
      gates: Object.freeze({
        contentFreeEvidence: true,
        historicalDecrypt: actor.historicalArtifactOpened,
        passed: true,
        readOnlyRuntime:
          podSpec.automountServiceAccountToken === false &&
          projectionMount.readOnly === true,
        realAtomicProjection: actor.atomicWriterSymlink,
        realKubernetesApi: true,
        rotationRecovered: actor.activeChanged,
        sameProcessRotation:
          actor.activeChanged &&
          terminated.pod.metadata.uid === podBefore.metadata.uid,
      }),
      limitations: LIMITATIONS,
    });
    const validation =
      validatePromptOutputProjectionKubernetesLiveReport(report);
    assert.equal(validation.compatible, true, validation.findings.join(', '));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    completed = true;
  } finally {
    if (completed || process.env[PRESERVE_FAILURE_ENV] !== '1') {
      await fixture.cleanup().catch(() => undefined);
      if (imageBuilt) {
        run(fixture.docker, ['image', 'rm', '-f', image], {
          allowFailure: true,
          capture: true,
          quiet: true,
        });
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { actorSource, projectionResources, secretManifest };
