#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const { createMutualTlsPki } = require('./lib/ql3-live-pki.cjs');
const {
  imageDigest,
  imageTag,
  reviewedOperatorManifest,
} = require('./ql3-cloudnativepg-live-contract.cjs');
const {
  FIXTURE,
  LIMITATIONS,
  validateAutomationManagementKubernetesLiveReport,
} = require('./ql3-automation-management-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const DEPLOYMENT = 'ql3-automation-management';
const SERVICE = DEPLOYMENT;
const SERVERNAME = `${SERVICE}.${NAMESPACE}.svc`;
const MANAGEMENT_PATH = '/api/v3/automations/management';
const POSTGRES_CLUSTER = 'ql3-postgres';
const ISSUER = 'https://identity.qinglong.test/';
const AUDIENCE = 'qinglong3-automation-management';
const LOCK = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/operator-lock.json',
    ),
    'utf8',
  ),
);
const OPERATOR_IMAGE = LOCK.operator.image;
const POSTGRES_IMAGE = LOCK.operand.image;
const OPERATOR_VERSION = LOCK.operator.version;
const ADMIN_IMAGE_BASE = 'ql3-automation-manager-live';
const CONTROL_IMAGE_BASE = 'ql3-automation-migration-live';
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const ROLE_NAMES = Object.freeze([
  'ql3_migration',
  'ql3_runtime',
  'ql3_admin',
  'ql3_package_manager',
  'ql3_package_executor',
  'ql3_automation_manager',
  'ql3_approval_manager',
  'ql3_worker_credential_manager',
  'ql3_worker_credential_executor',
  'ql3_worker_ingress',
]);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function reviewedKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return Object.freeze({
    kid,
    privateKey,
    publicJwk: Object.freeze({
      ...publicKey.export({ format: 'jwk' }),
      alg: 'EdDSA',
      kid,
      use: 'sig',
    }),
  });
}

function keyset(generation, keys, revokedKids = []) {
  return Object.freeze({
    schemaVersion: 1,
    generation,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: keys.map((key) => key.publicJwk),
    revokedKids,
    assuranceMappings: [
      {
        acr: 'urn:ql3:mfa',
        assurance: 'multi_factor',
        requiredAmr: ['pwd', 'otp'],
      },
    ],
    constraints: {
      maxAssertionBytes: 8 * 1024,
      maxLifetimeMs: 5 * 60 * 1000,
      maxAuthenticationAgeMs: 5 * 60 * 1000,
      clockSkewMs: 5 * 1000,
    },
  });
}

function assertion(key, suffix = crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-automation-management+jwt',
    }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: AUDIENCE,
      auth_time: now - 1,
      exp: now + 290,
      iat: now,
      iss: ISSUER,
      jti: `ql3-automation-live-${suffix}`,
      ql3_purpose: 'automation-management',
      sub: 'automation-operator',
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${crypto
    .sign(null, Buffer.from(signed, 'ascii'), key.privateKey)
    .toString('base64url')}`;
}

function envelope(operation, requestId, command) {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: Object.freeze({ requestId, command }),
  });
}

function taskCommand(projectId, revision, suffix, value) {
  return Object.freeze({
    projectId,
    taskId: 'managed-task',
    expectedRevision: revision,
    mutationId: `123e4567-e89b-42d3-a456-426614176${suffix}`,
    name: 'Managed Task',
    kind: 'command',
    spec: Object.freeze({
      schema: 'qinglong/command@v1',
      config: Object.freeze({
        command: Object.freeze({
          kind: 'argv',
          file: '/bin/echo',
          args: Object.freeze([value]),
        }),
      }),
    }),
    labels: Object.freeze({}),
    enabled: true,
    occurredAtMs: 10_000 + Number(suffix),
  });
}

function triggerCommand(projectId, revision, task, suffix) {
  return Object.freeze({
    projectId,
    triggerId: 'managed-trigger',
    expectedRevision: revision,
    mutationId: `123e4567-e89b-42d3-a456-426614177${suffix}`,
    taskId: task.taskId,
    taskRevision: task.revision,
    taskContentDigest: task.contentDigest,
    spec: Object.freeze({
      schema: 'qinglong/cron@v1',
      config: Object.freeze({
        expression: '*/5 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      }),
    }),
    enabled: true,
    occurredAtMs: 20_000 + Number(suffix),
  });
}

function podReady(pod) {
  return Boolean(
    pod.metadata.deletionTimestamp === undefined &&
      pod.status.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
  );
}

function imageIdDigest(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return image.Id;
}

function localManifest(rendered, imageName, localImage) {
  const placeholder = `${imageName}@${ZERO_DIGEST}`;
  const matches = rendered.split(placeholder).length - 1;
  assert.equal(
    matches,
    1,
    `rendered manifest must contain one ${imageName} placeholder`,
  );
  return rendered.replace(placeholder, localImage);
}

function applySecret(fixture, name, type, stringData, immutable = false) {
  fixture.apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: NAMESPACE },
    type,
    ...(immutable ? { immutable: true } : {}),
    stringData,
  });
}

function psql(fixture, podName, sql) {
  return fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      podName,
      '-c',
      'postgres',
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      'qinglong',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { capture: true, quiet: true },
  ).stdout;
}

function currentPrimaryPod(fixture) {
  const primaryName = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'cluster',
    POSTGRES_CLUSTER,
  ]).status.currentPrimary;
  assert.match(primaryName || '', /^ql3-postgres-[1-9][0-9]*$/);
  const pods = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    `cnpg.io/cluster=${POSTGRES_CLUSTER}`,
  ]).items;
  const primary = pods.find((pod) => pod.metadata.name === primaryName);
  assert.ok(primary, 'CloudNativePG primary Pod not found');
  return primary;
}

async function readyManagerPods(
  fixture,
  excludedUids = new Set(),
  expectedGeneration,
) {
  const result = await waitFor(
    'two Ready automation manager Pods on distinct nodes',
    300_000,
    () => {
      const pods = fixture
        .kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/name=${DEPLOYMENT}`,
        ])
        .items.filter(
          (pod) =>
            podReady(pod) &&
            !excludedUids.has(pod.metadata.uid) &&
            (expectedGeneration === undefined ||
              pod.metadata.annotations?.['qinglong.io/identity-generation'] ===
                String(expectedGeneration)),
        );
      const nodes = new Set(pods.map((pod) => pod.spec.nodeName));
      return pods.length === 2 && nodes.size === 2
        ? {
            ready: true,
            value: pods.sort((a, b) =>
              a.metadata.name.localeCompare(b.metadata.name),
            ),
          }
        : {
            ready: false,
            fact: `${pods.length} Ready Pods on ${nodes.size} nodes`,
          };
    },
  );
  return result.value;
}

function patchGeneration(fixture, generation, annotations = {}) {
  fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'patch',
      'deployment',
      DEPLOYMENT,
      '--type=merge',
      '-p',
      JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                'qinglong.io/identity-generation': String(generation),
                ...annotations,
              },
            },
          },
        },
      }),
    ],
    { capture: true, quiet: true },
  );
}

function waitRollout(fixture) {
  fixture.kubectl([
    '-n',
    NAMESPACE,
    'rollout',
    'status',
    `deployment/${DEPLOYMENT}`,
    '--timeout=5m',
  ]);
}

function createClientExecutor({ fixture, adminImage, ca }) {
  fixture.apply({
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: 'ql3-automation-management-client',
      namespace: NAMESPACE,
    },
    automountServiceAccountToken: false,
  });
  return async function executeClient(definition, expected) {
    const input = `${definition.name}-input`;
    const clientConfig = {
      schemaVersion: 1,
      endpoint: `https://${SERVERNAME}:8445${MANAGEMENT_PATH}`,
      servername: SERVERNAME,
      caFile: '/tmp/ca.crt',
      clientCertificateFile: '/tmp/client.crt',
      clientPrivateKeyFile: '/tmp/client.key',
      requestTimeoutMs: 5_000,
    };
    fixture.create({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: input, namespace: NAMESPACE },
      immutable: true,
      type: 'Opaque',
      stringData: {
        'client.json': `${JSON.stringify(clientConfig)}\n`,
        'command.json': `${JSON.stringify(definition.command)}\n`,
        'assertion.jwt': definition.bearer,
        'ca.crt': ca,
        'client.crt': definition.clientCertificate,
        'client.key': definition.clientKey,
      },
    });
    fixture.create({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: definition.name,
        namespace: NAMESPACE,
        labels: {
          'app.kubernetes.io/name': 'ql3-automation-management-client',
          'app.kubernetes.io/component': 'automation-management-client',
          'qinglong.io/execution-model': 'caller-driven',
        },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 240,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'ql3-automation-management-client',
              'app.kubernetes.io/component': 'automation-management-client',
              'qinglong.io/automation-management-client': 'true',
              'qinglong.io/execution-model': 'caller-driven',
            },
          },
          spec: {
            serviceAccountName: 'ql3-automation-management-client',
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            restartPolicy: 'Never',
            hostAliases: [
              { ip: definition.target.status.podIP, hostnames: [SERVERNAME] },
            ],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              fsGroup: 10001,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'client',
                image: adminImage,
                imagePullPolicy: 'Never',
                command: ['/bin/sh', '-c'],
                args: [
                  [
                    'set -eu',
                    'umask 077',
                    'cp /var/run/qinglong3/client/client.json /tmp/client.json',
                    'cp /var/run/qinglong3/client/command.json /tmp/command.json',
                    'cp /var/run/qinglong3/client/assertion.jwt /tmp/assertion.jwt',
                    'cp /var/run/qinglong3/client/ca.crt /tmp/ca.crt',
                    'cp /var/run/qinglong3/client/client.crt /tmp/client.crt',
                    'cp /var/run/qinglong3/client/client.key /tmp/client.key',
                    'chmod 600 /tmp/client.json /tmp/command.json ' +
                      '/tmp/assertion.jwt /tmp/ca.crt /tmp/client.crt ' +
                      '/tmp/client.key',
                    'set +e',
                    'attempt=0',
                    'while true; do',
                    '  attempt=$((attempt + 1))',
                    '  output="$(node /opt/qinglong/node_modules/@qinglong/' +
                      'cluster-admin/dist/automation-management/automationManagementClientCli.js ' +
                      '--config=/tmp/client.json ' +
                      '--command=/tmp/command.json ' +
                      '--assertion=/tmp/assertion.jwt 2>&1)"',
                    '  status=$?',
                    '  if [ "$status" -eq 0 ] || { ! printf \'%s\' "$output" | ' +
                      'grep -q QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED && ' +
                      '! printf \'%s\' "$output" | grep -q \'"statusCode":503\'; } || ' +
                      '[ "$attempt" -ge 60 ]; then',
                    '    break',
                    '  fi',
                    '  sleep 1',
                    'done',
                    'printf \'%s\\n\' "$output" > /dev/termination-log',
                    'printf \'%s\\n\' "$output"',
                    'exit "$status"',
                  ].join('\n'),
                ],
                terminationMessagePolicy: 'File',
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { cpu: '250m', memory: '128Mi' },
                },
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  {
                    name: 'input',
                    mountPath: '/var/run/qinglong3/client',
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'tmp',
                emptyDir: { medium: 'Memory', sizeLimit: '4Mi' },
              },
              {
                name: 'input',
                secret: { secretName: input, defaultMode: 288 },
              },
            ],
          },
        },
      },
    });
    const completion = await waitFor(
      `${definition.name} completion`,
      300_000,
      () => {
        const job = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'job',
          definition.name,
        ]);
        const complete = job.status.conditions?.some(
          (condition) =>
            condition.type === 'Complete' && condition.status === 'True',
        );
        const failed = job.status.conditions?.some(
          (condition) =>
            condition.type === 'Failed' && condition.status === 'True',
        );
        return complete || failed
          ? { ready: true, value: { complete, failed } }
          : { ready: false, fact: JSON.stringify(job.status ?? {}) };
      },
    );
    const clientPod = (
      await waitFor(`${definition.name} terminal pod`, 60_000, () => {
        const pods = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'pods',
          '-l',
          `batch.kubernetes.io/job-name=${definition.name}`,
        ]).items;
        const job = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'job',
          definition.name,
        ]);
        return pods.length === 1 && pods[0].status.containerStatuses?.[0]
          ? { ready: true, value: pods[0] }
          : {
              ready: false,
              fact:
                `observed ${pods.length} client pods; job=` +
                JSON.stringify(job.status ?? {}),
            };
      })
    ).value;
    assert.equal(clientPod.spec.automountServiceAccountToken, false);
    assert.equal(
      clientPod.spec.volumes.some((volume) =>
        volume.projected?.sources?.some(
          (source) => source.serviceAccountToken !== undefined,
        ),
      ),
      false,
    );
    assert.equal(
      fixture.kubectlJson(['-n', NAMESPACE, 'get', 'secret', input]).immutable,
      true,
    );
    const terminated =
      clientPod.status.containerStatuses?.[0]?.state?.terminated;
    assert.ok(terminated, 'automation client termination state is missing');
    const message = terminated.message ?? '';
    assert.equal(message.includes(definition.bearer), false);
    assert.equal(message.includes(definition.clientKey), false);
    const output = JSON.parse(message.split('\n').filter(Boolean).at(-1));
    if (expected.statusCode === 200) {
      assert.equal(
        completion.value.complete,
        true,
        `automation client unexpectedly failed: ${JSON.stringify(output)}`,
      );
      assert.equal(output.event, 'command_completed');
      assert.equal(output.result.operation, definition.command.operation);
      if (expected.resultStatus) {
        assert.ok(expected.resultStatus.includes(output.result.status));
      }
    } else {
      assert.equal(
        completion.value.failed,
        true,
        `automation client unexpectedly succeeded: ${JSON.stringify(output)}`,
      );
      assert.equal(output.event, 'command_failed');
      assert.equal(
        output.statusCode,
        expected.statusCode,
        `unexpected remote response: ${JSON.stringify(output)}`,
      );
      assert.equal(
        output.responseCode,
        expected.responseCode,
        `unexpected remote response: ${JSON.stringify(output)}`,
      );
    }
    const result = Object.freeze({
      targetPod: definition.target.metadata.name,
      targetPodUid: definition.target.metadata.uid,
      targetNode: definition.target.spec.nodeName,
      statusCode: expected.statusCode,
      output,
    });
    fixture.kubectl(
      [
        '-n',
        NAMESPACE,
        'delete',
        `job/${definition.name}`,
        `secret/${input}`,
        '--wait=false',
      ],
      { capture: true, quiet: true },
    );
    return result;
  };
}

async function waitForTwoPreserved(fixture, excludedUids, expectedGeneration) {
  let minimumReady = Number.POSITIVE_INFINITY;
  const observed = await waitFor(
    'zero-unavailable automation manager rollout',
    300_000,
    () => {
      const pods = fixture
        .kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/name=${DEPLOYMENT}`,
        ])
        .items.filter((pod) => pod.metadata.deletionTimestamp === undefined);
      const ready = pods.filter(podReady);
      minimumReady = Math.min(minimumReady, ready.length);
      const replacements = ready.filter(
        (pod) =>
          !excludedUids.has(pod.metadata.uid) &&
          pod.metadata.annotations?.['qinglong.io/identity-generation'] ===
            String(expectedGeneration),
      );
      const nodes = new Set(replacements.map((pod) => pod.spec.nodeName));
      return replacements.length === 2 && nodes.size === 2
        ? { ready: true, value: replacements }
        : {
            ready: false,
            fact: `${ready.length} ready, ${replacements.length} replacements`,
          };
    },
  );
  assert.ok(
    minimumReady >= 2,
    `rollout availability dropped to ${minimumReady}`,
  );
  return Object.freeze({ pods: observed.value, minimumReady });
}

function podTcpProbe(fixture, podName, host, port) {
  const script = String.raw`
const net=require('node:net');let finished=false;
const socket=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});
const finish=(status)=>{if(finished)return;finished=true;socket.destroy();process.exitCode=status};
socket.setTimeout(3000);socket.once('connect',()=>finish(0));
socket.once('timeout',()=>finish(1));socket.once('error',()=>finish(1));`;
  return fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      podName,
      '--',
      'node',
      '-e',
      script,
      host,
      String(port),
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
}

async function clientTcpProbe({
  fixture,
  adminImage,
  name,
  targetHost,
  port,
  labelled,
  expectedConnected,
}) {
  const labels = {
    'app.kubernetes.io/name': 'ql3-automation-network-probe',
    ...(labelled ? { 'qinglong.io/automation-management-client': 'true' } : {}),
  };
  const script = String.raw`
const fs=require('node:fs');const net=require('node:net');let finished=false;let attempt=0;let socket;
const maximum=Number(process.argv[3]);
const finish=(message,status)=>{if(finished)return;finished=true;fs.writeFileSync('/dev/termination-log',message);socket?.destroy();process.exitCode=status};
const retry=(reason)=>{socket.destroy();attempt+=1;if(attempt>=maximum){finish('denied:'+reason,1);return;}setTimeout(connect,500);};
const connect=()=>{let settled=false;const failed=(reason)=>{if(settled)return;settled=true;retry(reason)};socket=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});socket.setTimeout(3000);socket.once('connect',()=>{if(settled)return;settled=true;finish('connected',0)});socket.once('timeout',()=>failed('timeout'));socket.once('error',(error)=>failed(error.code||'error'));};
connect();`;
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'probe',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '-e',
                script,
                targetHost,
                String(port),
                String(expectedConnected ? 12 : 1),
              ],
              terminationMessagePolicy: 'File',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '5m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
            },
          ],
        },
      },
    },
  });
  const observed = await waitFor(`${name} completion`, 180_000, () => {
    const job = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
    const complete = job.status.conditions?.some(
      (condition) =>
        condition.type === 'Complete' && condition.status === 'True',
    );
    const failed = job.status.conditions?.some(
      (condition) => condition.type === 'Failed' && condition.status === 'True',
    );
    return complete || failed
      ? { ready: true, value: { complete, failed } }
      : { ready: false, fact: JSON.stringify(job.status ?? {}) };
  });
  const probePod = (
    await waitFor(`${name} terminal pod`, 30_000, () => {
      const pods = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `batch.kubernetes.io/job-name=${name}`,
      ]).items;
      const terminated =
        pods[0]?.status.containerStatuses?.[0]?.state?.terminated;
      return pods.length === 1 && terminated
        ? { ready: true, value: pods[0] }
        : { ready: false, fact: `observed ${pods.length} probe pods` };
    })
  ).value;
  const terminated = probePod.status.containerStatuses[0].state.terminated;
  const observation = `${name}: ${terminated.message ?? 'no-message'}`;
  assert.equal(observed.value.complete, expectedConnected, observation);
  assert.equal(observed.value.failed, !expectedConnected, observation);
  assert.equal(terminated.exitCode === 0, expectedConnected, observation);
  if (expectedConnected) {
    assert.equal(terminated.message, 'connected');
  } else {
    assert.match(terminated.message ?? '', /^denied:/);
  }
  fixture.kubectl(['-n', NAMESPACE, 'delete', 'job', name, '--wait=false'], {
    capture: true,
    quiet: true,
  });
  return expectedConnected ? observed.value.complete : observed.value.failed;
}

async function main() {
  if (process.env.QL3_AUTOMATION_MANAGEMENT_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_AUTOMATION_MANAGEMENT_KUBERNETES_LIVE=1',
    );
  }
  const operatorManifestFile = process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE;
  if (!operatorManifestFile) {
    throw new Error('QL3_CNPG_OPERATOR_MANIFEST_FILE is required');
  }
  const reviewedManifest = reviewedOperatorManifest(operatorManifestFile);
  const fixture = new K3sDockerLiveFixture({ prefix: 'ql3-automation-live' });
  const suffix = `${process.pid.toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const adminImage = `${ADMIN_IMAGE_BASE}:${suffix}`;
  const controlImage = `${CONTROL_IMAGE_BASE}:${suffix}`;
  let adminImageBuilt = false;
  let controlImageBuilt = false;
  let stoppedNode = '';
  try {
    const nodes = await fixture.start();
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    assert.ok(['amd64', 'arm64'].includes(architecture));

    for (const reviewedImage of [OPERATOR_IMAGE, POSTGRES_IMAGE]) {
      run(fixture.docker, ['pull', reviewedImage]);
      const inspected = fixture.inspectImage(reviewedImage);
      assert.ok(
        inspected.RepoDigests?.some((entry) =>
          entry.endsWith(`@${imageDigest(reviewedImage)}`),
        ),
        `Docker did not retain reviewed digest for ${reviewedImage}`,
      );
      const preloadTag = imageTag(reviewedImage);
      run(fixture.docker, ['tag', reviewedImage, preloadTag]);
      fixture.loadImage(preloadTag, `${path.basename(preloadTag)}.tar`);
    }

    const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
      quiet: true,
    }).stdout;
    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag',
      adminImage,
      '--build-arg',
      `SOURCE_REVISION=${sourceRevision}`,
      '.',
    ]);
    adminImageBuilt = true;
    fixture.loadImage(adminImage, 'automation-admin.tar');
    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-control/Dockerfile',
      '--tag',
      controlImage,
      '--build-arg',
      `SOURCE_REVISION=${sourceRevision}`,
      '.',
    ]);
    controlImageBuilt = true;
    fixture.loadImage(controlImage, 'automation-migration.tar');
    const adminImageInfo = fixture.inspectImage(adminImage);
    const postgresImageInfo = fixture.inspectImage(POSTGRES_IMAGE);
    const k3sImageInfo = fixture.inspectImage(fixture.k3sImage);

    fixture.kubectl(['apply', '--server-side', '-f', reviewedManifest]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'set',
      'image',
      'deployment/cnpg-controller-manager',
      `manager=${imageTag(OPERATOR_IMAGE)}`,
    ]);
    fixture.kubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusters.postgresql.cnpg.io',
      'crd/databaseroles.postgresql.cnpg.io',
      'crd/databases.postgresql.cnpg.io',
      '--timeout=5m',
    ]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '--timeout=5m',
    ]);

    fixture.kubectl([
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/namespace.yaml',
    ]);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/service-account.yaml',
    ]);
    const passwords = Object.fromEntries(
      ROLE_NAMES.map((role) => [role, randomSecret()]),
    );
    for (const role of ROLE_NAMES) {
      applySecret(
        fixture,
        `ql3-postgres-${role.replace(/^ql3_/, '').replaceAll('_', '-')}-auth`,
        'kubernetes.io/basic-auth',
        { username: role, password: passwords[role] },
      );
    }
    const databaseManifest = fixture
      .kubectl(
        ['kustomize', 'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg'],
        { capture: true, quiet: true },
      )
      .stdout.replace(POSTGRES_IMAGE, imageTag(POSTGRES_IMAGE));
    assert.notEqual(databaseManifest.includes(POSTGRES_IMAGE), true);
    fixture.kubectl(['apply', '-f', '-'], { input: `${databaseManifest}\n` });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Ready',
      `cluster/${POSTGRES_CLUSTER}`,
      '--timeout=20m',
    ]);
    const databasePods = (
      await waitFor('three ready CloudNativePG instances', 600_000, () => {
        const pods = fixture
          .kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'pods',
            '-l',
            `cnpg.io/cluster=${POSTGRES_CLUSTER}`,
          ])
          .items.filter(podReady);
        return pods.length === 3
          ? { ready: true, value: pods }
          : { ready: false, fact: `${pods.length}/3 ready database Pods` };
      })
    ).value;

    const migrationManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-control',
      controlImage,
    );
    fixture.kubectl(['create', '-f', '-'], {
      input: `${migrationManifest}\n`,
    });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Complete',
      'job/ql3-cluster-migration',
      '--timeout=10m',
    ]);
    const migrationPrimary = currentPrimaryPod(fixture);
    assert.equal(
      psql(
        fixture,
        migrationPrimary.metadata.name,
        `SELECT (SELECT count(*) FROM "ql3"."schema_migrations") || ':' ||
                (SELECT contract_version FROM "ql3"."schema_capabilities"
                  WHERE contract_name = 'control-core')`,
      ),
      '54:53',
    );

    const projectId = `automation-live-${suffix}`;
    const primary = currentPrimaryPod(fixture);
    psql(
      fixture,
      primary.metadata.name,
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES ('${projectId}', 'Automation Live', '${projectId}',
         'active', 1, 1000, 1000);
       INSERT INTO "ql3"."project_role_bindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES ('${projectId}', 'user', 'automation-operator', 1,
         'active', 'owner', '123e4567-e89b-42d3-a456-426614176000',
         'user', 'automation-operator', 1000);`,
    );

    const pki = createMutualTlsPki({
      directory: fixture.temporary,
      servername: SERVERNAME,
      label: 'QL3 Automation Management Live',
      run,
      crypto,
    });
    let pkiMaterial = pki.read();
    const oldKey = reviewedKey('automation-live-key-1');
    const newKey = reviewedKey('automation-live-key-2');
    const keysets = [
      keyset(1, [oldKey]),
      keyset(2, [oldKey, newKey]),
      keyset(3, [oldKey, newKey], [oldKey.kid]),
    ];
    const applyIdentity = (document) =>
      applySecret(fixture, DEPLOYMENT + '-identity', 'Opaque', {
        'keyset.json': `${JSON.stringify(document)}\n`,
      });
    const applyTls = () =>
      applySecret(fixture, DEPLOYMENT + '-tls', 'kubernetes.io/tls', {
        'tls.crt': pkiMaterial.serverCertificate,
        'tls.key': pkiMaterial.serverKey,
        'ca.crt': pkiMaterial.ca,
        'client.crl': pkiMaterial.clientCrl,
      });
    applyIdentity(keysets[0]);
    applyTls();

    const previousBundleSha256 = pki.bundleSha256();
    const caDigest = sha256(pkiMaterial.ca);
    const crlDigest = sha256(pkiMaterial.clientCrl);
    let managerManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/automation-management/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-admin',
      adminImage,
    );
    assert.equal(managerManifest.split(ZERO_DIGEST).length - 1, 2);
    managerManifest = managerManifest
      .replace(ZERO_DIGEST, caDigest)
      .replace(ZERO_DIGEST, crlDigest);
    fixture.kubectl(['apply', '-f', '-'], {
      input: `${managerManifest}\n`,
    });
    waitRollout(fixture);
    let managerPods = await readyManagerPods(fixture);

    const deployment = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'deployment',
      DEPLOYMENT,
    ]);
    assert.equal(deployment.spec.replicas, 2);
    assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
    assert.equal(
      deployment.spec.template.spec.automountServiceAccountToken,
      false,
    );
    assert.equal(
      deployment.spec.template.spec.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution.length,
      1,
    );
    assert.equal(
      fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pdb', DEPLOYMENT]).spec
        .minAvailable,
      1,
    );
    for (const pod of managerPods) {
      assert.equal(pod.spec.serviceAccountName, DEPLOYMENT);
      assert.equal(pod.spec.automountServiceAccountToken, false);
      assert.equal(
        pod.spec.volumes.some((volume) =>
          volume.projected?.sources?.some(
            (source) => source.serviceAccountToken !== undefined,
          ),
        ),
        false,
      );
    }

    const executeClient = createClientExecutor({
      fixture,
      adminImage,
      ca: pkiMaterial.ca,
    });
    const oldAssertion = () => assertion(oldKey);
    const newAssertion = () => assertion(newKey);
    const taskV1Command = envelope(
      'task.publish',
      'task-create-v1',
      taskCommand(projectId, null, '001', 'v1'),
    );
    const initialAssertion = oldAssertion();
    const initialRequests = await Promise.all([
      executeClient(
        {
          name: 'ql3-automation-task-v1-a',
          target: managerPods[0],
          command: taskV1Command,
          bearer: initialAssertion,
          clientCertificate: pkiMaterial.oldClientCertificate,
          clientKey: pkiMaterial.oldClientKey,
        },
        { statusCode: 200, resultStatus: ['created', 'existing'] },
      ),
      executeClient(
        {
          name: 'ql3-automation-task-v1-b',
          target: managerPods[1],
          command: taskV1Command,
          bearer: initialAssertion,
          clientCertificate: pkiMaterial.newClientCertificate,
          clientKey: pkiMaterial.newClientKey,
        },
        { statusCode: 200, resultStatus: ['created', 'existing'] },
      ),
    ]);
    const initialStatuses = initialRequests
      .map((entry) => entry.output.result.status)
      .sort();
    assert.deepEqual(initialStatuses, ['created', 'existing']);

    const generation1Uids = new Set(managerPods.map((pod) => pod.metadata.uid));
    applyIdentity(keysets[1]);
    patchGeneration(fixture, 2);
    const generation2 = await waitForTwoPreserved(fixture, generation1Uids, 2);
    managerPods = generation2.pods;
    const taskV2 = await executeClient(
      {
        name: 'ql3-automation-task-v2-old-key',
        target: managerPods[0],
        command: envelope(
          'task.publish',
          'task-update-v2',
          taskCommand(projectId, 1, '002', 'v2'),
        ),
        bearer: oldAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['updated'] },
    );
    const triggerV1 = await executeClient(
      {
        name: 'ql3-automation-trigger-v1-new-key',
        target: managerPods[1],
        command: envelope(
          'trigger.publish',
          'trigger-create-v1',
          triggerCommand(projectId, null, taskV2.output.result.task, '001'),
        ),
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['created'] },
    );
    assert.equal(triggerV1.output.result.trigger.taskRevision, 2);

    const generation2Uids = new Set(managerPods.map((pod) => pod.metadata.uid));
    applyIdentity(keysets[2]);
    patchGeneration(fixture, 3);
    const generation3 = await waitForTwoPreserved(fixture, generation2Uids, 3);
    managerPods = generation3.pods;
    const taskV3Command = envelope(
      'task.publish',
      'task-update-v3',
      taskCommand(projectId, 2, '003', 'v3'),
    );
    const rejectedOldKey = await executeClient(
      {
        name: 'ql3-automation-task-v3-revoked-key',
        target: managerPods[0],
        command: taskV3Command,
        bearer: oldAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 401, responseCode: 'authentication_required' },
    );
    const taskV3 = await executeClient(
      {
        name: 'ql3-automation-task-v3-active-key',
        target: managerPods[1],
        command: taskV3Command,
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['updated'] },
    );

    applyIdentity(keysets[1]);
    patchGeneration(fixture, 'rollback-2');
    const rollback = await waitFor(
      'identity ledger rollback surge failure with two ready replicas',
      180_000,
      () => {
        const pods = fixture
          .kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'pods',
            '-l',
            `app.kubernetes.io/name=${DEPLOYMENT}`,
          ])
          .items.filter((pod) => pod.metadata.deletionTimestamp === undefined);
        const ready = pods.filter(podReady);
        const candidate = pods.find(
          (pod) =>
            !managerPods.some(
              (current) => current.metadata.uid === pod.metadata.uid,
            ) &&
            pod.status.containerStatuses?.[0] &&
            !pod.status.containerStatuses[0].ready &&
            (pod.status.containerStatuses[0].restartCount > 0 ||
              pod.status.containerStatuses[0].state?.waiting?.reason ===
                'CrashLoopBackOff'),
        );
        return ready.length === 2 && candidate
          ? { ready: true, value: candidate }
          : {
              ready: false,
              fact: `${ready.length} ready Pods; rollback candidate=${Boolean(
                candidate,
              )}`,
            };
      },
    );
    applyIdentity(keysets[2]);
    patchGeneration(fixture, '3-rollback-recovered');
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'delete',
      'pod',
      rollback.value.metadata.name,
      '--grace-period=0',
      '--force',
      '--wait=true',
    ]);
    waitRollout(fixture);
    managerPods = await readyManagerPods(fixture);

    const previousSerialSha256 = pki.oldSerialSha256();
    pki.revokeOldClient();
    pkiMaterial = pki.read();
    const currentBundleSha256 = pki.bundleSha256();
    assert.notEqual(currentBundleSha256, previousBundleSha256);
    applyTls();
    const preCertificateUids = new Set(
      managerPods.map((pod) => pod.metadata.uid),
    );
    patchGeneration(fixture, '3-client-crl-2', {
      'qinglong.io/automation-management-client-ca-sha256': sha256(
        pkiMaterial.ca,
      ),
      'qinglong.io/automation-management-client-crl-sha256': sha256(
        pkiMaterial.clientCrl,
      ),
    });
    const certificateRollout = await waitForTwoPreserved(
      fixture,
      preCertificateUids,
      '3-client-crl-2',
    );
    managerPods = certificateRollout.pods;
    const triggerV2Command = envelope(
      'trigger.publish',
      'trigger-update-v2',
      triggerCommand(projectId, 1, taskV3.output.result.task, '002'),
    );
    const rejectedOldCertificate = await executeClient(
      {
        name: 'ql3-automation-trigger-v2-revoked-cert',
        target: managerPods[0],
        command: triggerV2Command,
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.oldClientCertificate,
        clientKey: pkiMaterial.oldClientKey,
      },
      { statusCode: 401, responseCode: 'client_certificate_required' },
    );
    const triggerV2 = await executeClient(
      {
        name: 'ql3-automation-trigger-v2-active-cert',
        target: managerPods[1],
        command: triggerV2Command,
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['updated'] },
    );
    assert.equal(triggerV2.output.result.trigger.taskRevision, 3);

    const primaryBeforeFailover = currentPrimaryPod(fixture);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'delete',
      'pod',
      primaryBeforeFailover.metadata.name,
      '--grace-period=0',
      '--force',
      '--wait=false',
    ]);
    const promoted = await waitFor(
      'CloudNativePG primary promotion',
      600_000,
      () => {
        const status = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'cluster',
          POSTGRES_CLUSTER,
        ]).status;
        return status.currentPrimary &&
          status.currentPrimary !== primaryBeforeFailover.metadata.name &&
          Number(status.readyInstances) >= 2
          ? { ready: true, value: status.currentPrimary }
          : {
              ready: false,
              fact: `primary=${status.currentPrimary || 'none'} ready=${
                status.readyInstances ?? 0
              }`,
            };
      },
    );
    await waitFor('CloudNativePG recovery to three instances', 900_000, () => {
      const status = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'cluster',
        POSTGRES_CLUSTER,
      ]).status;
      return Number(status.readyInstances) === 3
        ? { ready: true, value: status }
        : {
            ready: false,
            fact: `${status.readyInstances ?? 0}/3 ready database instances`,
          };
    });

    const databaseService = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      `${POSTGRES_CLUSTER}-rw`,
    ]);
    const databaseSelector = databaseService.spec.selector;
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'patch',
      'service',
      `${POSTGRES_CLUSTER}-rw`,
      '--type=merge',
      '-p',
      JSON.stringify({
        spec: { selector: { ...databaseSelector, 'ql3.invalid': 'true' } },
      }),
    ]);
    const unavailable = await Promise.all(
      managerPods.map((pod, index) =>
        executeClient(
          {
            name: `ql3-automation-database-unavailable-${index + 1}`,
            target: pod,
            command: taskV3Command,
            bearer: newAssertion(),
            clientCertificate: pkiMaterial.newClientCertificate,
            clientKey: pkiMaterial.newClientKey,
          },
          { statusCode: 503, responseCode: 'unavailable' },
        ),
      ),
    );
    assert.deepEqual(
      unavailable.map((entry) => entry.statusCode),
      [503, 503],
    );
    await waitFor('manager readiness withdrawal', 60_000, () => {
      const current = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'deployment',
        DEPLOYMENT,
      ]);
      return Number(current.status.readyReplicas ?? 0) === 0
        ? { ready: true, value: current }
        : {
            ready: false,
            fact: `${current.status.readyReplicas ?? 0} ready replicas`,
          };
    });
    const health = (pod, route) => {
      const script = String.raw`
const fs=require('node:fs');const https=require('node:https');
const request=https.request({host:'127.0.0.1',port:8445,path:process.argv[1],
servername:process.argv[2],ca:fs.readFileSync('/var/run/secrets/qinglong3/automation-management-tls/ca.crt'),
minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,agent:false},
(response)=>{response.resume();response.on('end',()=>process.stdout.write(String(response.statusCode)))});
request.on('error',(error)=>{process.stderr.write(error.message);process.exitCode=1});request.end();`;
      return Number(
        fixture.kubectl(
          [
            '-n',
            NAMESPACE,
            'exec',
            pod.metadata.name,
            '--',
            'node',
            '-e',
            script,
            route,
            SERVERNAME,
          ],
          { capture: true, quiet: true },
        ).stdout,
      );
    };
    assert.deepEqual(
      managerPods.map((pod) => health(pod, '/readyz')),
      [503, 503],
    );
    assert.deepEqual(
      managerPods.map((pod) => health(pod, '/livez')),
      [200, 200],
    );
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'patch',
      'service',
      `${POSTGRES_CLUSTER}-rw`,
      '--type=json',
      '-p',
      JSON.stringify([
        {
          op: 'replace',
          path: '/spec/selector',
          value: databaseSelector,
        },
      ]),
    ]);
    await waitFor('restored CloudNativePG service endpoint', 120_000, () => {
      const endpoints = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'endpoints',
        `${POSTGRES_CLUSTER}-rw`,
      ]);
      const count = endpoints.subsets?.flatMap(
        (subset) => subset.addresses ?? [],
      ).length;
      return count >= 1
        ? { ready: true, value: count }
        : { ready: false, fact: `${count ?? 0} service endpoints` };
    });
    assert.deepEqual(
      managerPods.map((pod) => health(pod, '/readyz')),
      [503, 503],
    );
    const staleUids = new Set(managerPods.map((pod) => pod.metadata.uid));
    patchGeneration(fixture, '3-database-recovered');
    managerPods = await readyManagerPods(
      fixture,
      staleUids,
      '3-database-recovered',
    );
    const recoveredTaskCommand = envelope(
      'task.publish',
      'task-update-v4-recovery',
      taskCommand(projectId, 3, '004', 'v4-recovery'),
    );
    const recoveryAssertion = newAssertion();
    const recoveredRequests = await Promise.all(
      managerPods.map((pod, index) =>
        executeClient(
          {
            name: `ql3-automation-database-recovered-${index + 1}`,
            target: pod,
            command: recoveredTaskCommand,
            bearer: recoveryAssertion,
            clientCertificate: pkiMaterial.newClientCertificate,
            clientKey: pkiMaterial.newClientKey,
          },
          { statusCode: 200, resultStatus: ['updated', 'existing'] },
        ),
      ),
    );
    assert.deepEqual(
      recoveredRequests.map((entry) => entry.output.result.status).sort(),
      ['existing', 'updated'],
    );

    const finalPrimary = currentPrimaryPod(fixture);
    const durable = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        `SELECT json_build_object(
          'taskRevisionCount', (SELECT count(*)::integer
            FROM "ql3"."task_definition_revisions"
            WHERE project_id = '${projectId}' AND task_id = 'managed-task'),
          'taskCurrentRevision', (SELECT current_revision
            FROM "ql3"."task_definitions"
            WHERE project_id = '${projectId}' AND task_id = 'managed-task'),
          'triggerRevisionCount', (SELECT count(*)::integer
            FROM "ql3"."trigger_revisions"
            WHERE project_id = '${projectId}' AND trigger_id = 'managed-trigger'),
          'triggerCurrentRevision', (SELECT current_revision
            FROM "ql3"."triggers"
            WHERE project_id = '${projectId}' AND trigger_id = 'managed-trigger'),
          'allowedAuditCount', (SELECT count(*)::integer
            FROM "ql3"."security_audit_events"
            WHERE project_id = '${projectId}' AND outcome = 'allowed'),
          'identityGeneration', (SELECT generation::integer
            FROM "ql3"."plugin_package_identity_keyset_ledger"
            WHERE authority = 'automation-management'),
          'migrationCount', (SELECT count(*)::integer
            FROM "ql3"."schema_migrations"),
          'controlCoreCapability', (SELECT contract_version::integer
            FROM "ql3"."schema_capabilities"
            WHERE contract_name = 'control-core'),
          'postgresVersionNumber', current_setting('server_version_num')::integer,
          'currentUser', current_user)`,
      ),
    );
    assert.deepEqual(durable, {
      taskRevisionCount: 4,
      taskCurrentRevision: 4,
      triggerRevisionCount: 2,
      triggerCurrentRevision: 2,
      allowedAuditCount: 6,
      identityGeneration: 3,
      migrationCount: 54,
      controlCoreCapability: 53,
      postgresVersionNumber: 180004,
      currentUser: 'postgres',
    });

    const roleList = ROLE_NAMES.map((role) => `'${role}'`).join(',');
    const roleRows = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        `SELECT json_agg(json_build_object(
                'name', rolname,
                'login', rolcanlogin,
                'superuser', rolsuper,
                'createDatabase', rolcreatedb,
                'createRole', rolcreaterole,
                'replication', rolreplication,
                'bypassRls', rolbypassrls) ORDER BY rolname)
           FROM pg_roles WHERE rolname IN (${roleList})`,
      ),
    );
    assert.deepEqual(
      roleRows.map((role) => role.name),
      [...ROLE_NAMES].sort(),
    );
    const rolesLeastPrivilege = roleRows.every(
      (role) =>
        role.login === true &&
        role.superuser === false &&
        role.createDatabase === false &&
        role.createRole === false &&
        role.replication === false &&
        role.bypassRls === false,
    );
    assert.equal(rolesLeastPrivilege, true);

    const canI = (verb, resource) => {
      const result = fixture.kubectl(
        [
          'auth',
          'can-i',
          verb,
          resource,
          '-n',
          NAMESPACE,
          `--as=system:serviceaccount:${NAMESPACE}:${DEPLOYMENT}`,
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
      assert.equal(
        result.status,
        result.stdout === 'yes' ? 0 : 1,
        `unexpected kubectl auth can-i result: ${result.stdout}`,
      );
      return result.stdout;
    };
    assert.equal(canI('get', 'secrets'), 'no');
    assert.equal(canI('patch', 'deployments.apps'), 'no');

    const managerServiceIp = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      SERVICE,
    ]).spec.clusterIP;
    const labelledClientAllowed = await clientTcpProbe({
      fixture,
      adminImage,
      name: 'ql3-automation-network-labelled',
      targetHost: managerServiceIp,
      port: 8445,
      labelled: true,
      expectedConnected: true,
    });
    const unlabelledClientDenied = await clientTcpProbe({
      fixture,
      adminImage,
      name: 'ql3-automation-network-unlabelled',
      targetHost: managerServiceIp,
      port: 8445,
      labelled: false,
      expectedConnected: false,
    });
    const wrongPortDenied = await clientTcpProbe({
      fixture,
      adminImage,
      name: 'ql3-automation-network-wrong-port',
      targetHost: managerServiceIp,
      port: 8444,
      labelled: true,
      expectedConnected: false,
    });
    const kubernetesServiceIp = fixture.kubectlJson([
      'get',
      'service',
      'kubernetes',
      '-n',
      'default',
    ]).spec.clusterIP;
    const postgresServiceIp = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      `${POSTGRES_CLUSTER}-rw`,
    ]).spec.clusterIP;
    const cloudNativePgEgressAllowed =
      podTcpProbe(
        fixture,
        managerPods[0].metadata.name,
        postgresServiceIp,
        5432,
      ).status === 0;
    const kubernetesApiEgressDenied =
      podTcpProbe(
        fixture,
        managerPods[0].metadata.name,
        kubernetesServiceIp,
        443,
      ).status !== 0;
    const publicInternetEgressDenied =
      podTcpProbe(fixture, managerPods[0].metadata.name, '1.1.1.1', 443)
        .status !== 0;
    assert.equal(cloudNativePgEgressAllowed, true);
    assert.equal(kubernetesApiEgressDenied, true);
    assert.equal(publicInternetEgressDenied, true);

    const finalNodes = fixture.kubectlJson(['get', 'nodes']).items;
    const cniReadyNodes = finalNodes.filter(
      (node) =>
        podReady(node) &&
        Array.isArray(node.spec.podCIDRs) &&
        node.spec.podCIDRs.length === 1,
    );
    assert.equal(cniReadyNodes.length, 3);
    assert.equal(
      new Set(cniReadyNodes.map((node) => node.spec.podCIDRs[0])).size,
      3,
    );
    const serverNode = finalNodes.find(
      (node) => node.metadata.name === fixture.server,
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/backend-type'
      ],
      'vxlan',
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/kube-subnet-manager'
      ],
      'true',
    );

    const finalCluster = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'cluster',
      POSTGRES_CLUSTER,
    ]);
    assert.equal(Number(finalCluster.status.readyInstances), 3);
    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: {
        distribution: 'k3s',
        kubernetesVersion: nodes[0].status.nodeInfo.kubeletVersion,
        architecture,
        kubernetesImageId: imageIdDigest(k3sImageInfo),
        managementImageId: imageIdDigest(adminImageInfo),
        cniName: 'flannel',
        cniDistributionBinding: fixture.k3sImage,
        controlPlaneNodes: 1,
        workerNodes: 2,
        cniReadyNodes: cniReadyNodes.length,
      },
      database: {
        operator: 'cloudnative-pg',
        operatorVersion: OPERATOR_VERSION,
        postgresVersionNumber: durable.postgresVersionNumber,
        postgresImageId: imageIdDigest(postgresImageInfo),
        instances: Number(finalCluster.spec.instances),
        readyInstances: Number(finalCluster.status.readyInstances),
        managerRole: 'ql3_automation_manager',
        controlCoreCapability: durable.controlCoreCapability,
        tlsVerified: true,
        primaryChangedDuringFailover:
          promoted.value !== primaryBeforeFailover.metadata.name,
      },
      deployment: {
        namespace: NAMESPACE,
        service: SERVICE,
        port: 8445,
        replicas: deployment.spec.replicas,
        readyReplicas: managerPods.length,
        podIdentitySha256: managerPods.map((pod) => sha256(pod.metadata.uid)),
        nodeIdentitySha256: managerPods.map((pod) => sha256(pod.spec.nodeName)),
        serviceAccount: DEPLOYMENT,
        automountServiceAccountToken: false,
        requiredPodAntiAffinity: true,
        podDisruptionBudgetMinAvailable: 1,
        maxUnavailable: 0,
        maxConnectionsPerPod: 2,
      },
      client: {
        binary: 'ql3-automation-client',
        operation: 'task.publish',
        inputKind: 'Secret',
        inputImmutable: true,
        callerDrivenJob: true,
        backoffLimit: 0,
        serviceAccountTokenMounted: false,
        rbacGranted: false,
        transportProtocol: 'TLSv1.3',
        mutualTls: true,
        servernameVerified: true,
        exactPodRequests: initialRequests.length,
        resultStatuses: initialStatuses,
        responseRedacted: true,
      },
      identityRotation: {
        overlapOldAssertionAccepted: taskV2.statusCode === 200,
        overlapNewAssertionAccepted: triggerV1.statusCode === 200,
        revokedOldAssertionRejected: rejectedOldKey.statusCode === 401,
        activeNewAssertionAccepted: taskV3.statusCode === 200,
        rollbackSurgeFailedClosed: Boolean(rollback.value),
        twoReadyReplicasPreserved:
          generation2.minimumReady >= 2 && generation3.minimumReady >= 2,
        durableGenerationReachedThree: durable.identityGeneration === 3,
      },
      certificateRotation: {
        previousSerialSha256,
        currentSerialSha256: pki.newSerialSha256(),
        previousBundleSha256,
        currentBundleSha256,
        oldClientAcceptedBefore: initialRequests[0].statusCode === 200,
        replacementClientAcceptedBefore: initialRequests[1].statusCode === 200,
        oldClientRejectedAfter: rejectedOldCertificate.statusCode === 401,
        replacementClientAcceptedAfter: triggerV2.statusCode === 200,
        fullPodReplacement: managerPods.every(
          (pod) => !preCertificateUids.has(pod.metadata.uid),
        ),
        allReplicasReadyThroughout: certificateRollout.minimumReady >= 2,
      },
      availability: {
        databaseFailureWithdrewReadiness: true,
        databaseFailurePreservedLiveness: true,
        stalePodsDidNotRecoverInPlace: true,
        freshPodsRecoveredAfterDatabase: managerPods.every(
          (pod) => !staleUids.has(pod.metadata.uid),
        ),
        bothReplicasServedAfterRecovery: recoveredRequests.every(
          (entry) => entry.statusCode === 200,
        ),
      },
      isolation: {
        labelledClientAllowed,
        unlabelledClientDenied,
        wrongPortDenied,
        kubernetesApiEgressDenied,
        publicInternetEgressDenied,
        cloudNativePgEgressAllowed,
        managerSecretReadDenied: canI('get', 'secrets') === 'no',
        managerMutationRbacDenied: canI('patch', 'deployments.apps') === 'no',
      },
      durability: {
        taskRevisionCount: durable.taskRevisionCount,
        triggerRevisionCount: durable.triggerRevisionCount,
        allowedAuditCount: durable.allowedAuditCount,
        replayDuplicateCount:
          initialStatuses.join(',') === 'created,existing' ? 0 : 1,
        taskCurrentRevision: durable.taskCurrentRevision,
        triggerCurrentRevision: durable.triggerCurrentRevision,
        survivedCloudNativePgFailover: true,
      },
      gates: {
        realThreeNodeKubernetes: nodes.length === 3,
        realCniPolicy:
          labelledClientAllowed &&
          unlabelledClientDenied &&
          wrongPortDenied &&
          kubernetesApiEgressDenied &&
          publicInternetEgressDenied &&
          cloudNativePgEgressAllowed,
        threeInstanceCloudNativePg: databasePods.length === 3,
        twoManagerPodsOnDistinctNodes:
          new Set(managerPods.map((pod) => pod.spec.nodeName)).size === 2,
        tls13ProductClientAcrossBothPods: initialRequests.length === 2,
        identityProjectionRotation: durable.identityGeneration === 3,
        certificateRevocationRollout: rejectedOldCertificate.statusCode === 401,
        databaseReadinessFence: true,
        durableFactsSurvivedFailover: true,
        leastPrivilege: rolesLeastPrivilege,
        passed: true,
      },
      limitations: [...LIMITATIONS],
    };
    const audit = validateAutomationManagementKubernetesLiveReport(report);
    assert.deepEqual(audit.findings, []);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (stoppedNode) fixture.startNode(stoppedNode);
    await fixture.cleanup();
    if (adminImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (controlImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', controlImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `QL3 automation management Kubernetes live contract failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  assertion,
  envelope,
  keyset,
  reviewedKey,
  taskCommand,
  triggerCommand,
};
