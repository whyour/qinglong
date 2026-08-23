#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  createModelProviderCredentialTestAllowlist,
} = require('../packages/ql3-ai/dist/model-provider-credential/modelProviderCredentialTestConnection.js');
const {
  projectedModelProviderSecretFileName,
} = require('../packages/ql3-ai/dist/model-provider-credential/projectedModelProviderSecretMaterial.js');
const {
  createSecretRef,
} = require('../packages/ql3-runtime-core/dist/secret/secretReference.js');
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
  AI_MIGRATION_COUNT,
  FIXTURE,
  LIMITATIONS,
  validateProviderCredentialTestKubernetesLiveReport,
} = require('./ql3-provider-credential-test-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const POSTGRES_CLUSTER = 'ql3-postgres';
const PROVIDER_NAME = 'ql3-provider-live';
const PROVIDER_PORT = 8443;
const PROVIDER_SERVERNAME = `${PROVIDER_NAME}.${NAMESPACE}.svc`;
const PROVIDER_URL = `https://${PROVIDER_SERVERNAME}:${PROVIDER_PORT}/v1/`;
const FIXTURE_STORAGE_CLASS = 'ql3-provider-test-static';
const PROJECT_ID = 'provider-credential-test-live';
const ACTOR_ID = 'provider-credential-test-owner';
const PROVIDER = 'openai-compatible';
const SECRET_NAME = 'provider-live-material';
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
const ADMIN_IMAGE_BASE = 'ql3-provider-credential-test-live-admin';
const CONTROL_IMAGE_BASE = 'ql3-provider-credential-test-live-migration';
const PRESERVE_FAILURE_ENV =
  'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_PRESERVE_FAILURE';
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const ACTOR_SOURCE = fs.readFileSync(
  path.join(
    ROOT,
    'scripts/ql3-provider-credential-test-kubernetes-live-actor.cjs',
  ),
  'utf8',
);
const ROLE_NAMES = Object.freeze([
  'ql3_migration',
  'ql3_ai_maintenance',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
  'ql3_runtime',
  'ql3_admin',
  'ql3_package_manager',
  'ql3_package_executor',
  'ql3_automation_manager',
  'ql3_approval_manager',
  'ql3_run_manager',
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

function imageIdDigest(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return image.Id;
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

function localManifest(rendered, imageName, localImage) {
  const placeholder = `${imageName}@${ZERO_DIGEST}`;
  const matches = rendered.split(placeholder).length - 1;
  assert.equal(matches, 1, `expected one ${imageName} image placeholder`);
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

function roleSecretName(role) {
  return `ql3-postgres-${role.replace(/^ql3_/, '').replaceAll('_', '-')}-auth`;
}

function applyFixturePostgresVolumes(fixture) {
  fixture.apply({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: FIXTURE_STORAGE_CLASS },
    provisioner: 'kubernetes.io/no-provisioner',
    volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: false,
  });
  assert.equal(fixture.nodes.length, 3);
  const storageNodes = [...fixture.nodes.slice(1), fixture.nodes[0]];
  storageNodes.forEach((nodeName, index) => {
    const instance = index + 1;
    for (const volume of [
      { suffix: 'data', claim: `ql3-postgres-${instance}`, capacity: '20Gi' },
      {
        suffix: 'wal',
        claim: `ql3-postgres-${instance}-wal`,
        capacity: '5Gi',
      },
    ]) {
      const hostPath = `/var/lib/qinglong3-live/postgres-${instance}-${volume.suffix}`;
      fixture.dockerRun(['exec', nodeName, 'mkdir', '-p', hostPath], {
        capture: true,
        quiet: true,
      });
      fixture.dockerRun(['exec', nodeName, 'chown', '26:26', hostPath], {
        capture: true,
        quiet: true,
      });
      fixture.dockerRun(['exec', nodeName, 'chmod', '0700', hostPath], {
        capture: true,
        quiet: true,
      });
      fixture.apply({
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: {
          name: `ql3-provider-test-pg-${instance}-${volume.suffix}`,
        },
        spec: {
          capacity: { storage: volume.capacity },
          volumeMode: 'Filesystem',
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: FIXTURE_STORAGE_CLASS,
          claimRef: {
            namespace: NAMESPACE,
            name: volume.claim,
          },
          nodeAffinity: {
            required: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [
                    {
                      key: 'kubernetes.io/hostname',
                      operator: 'In',
                      values: [nodeName],
                    },
                  ],
                },
              ],
            },
          },
          hostPath: {
            path: hostPath,
            type: 'Directory',
          },
        },
      });
    }
  });
}

function applyCloudNativePgResources(fixture) {
  const rendered = fixture.kubectl(
    ['kustomize', 'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg'],
    { capture: true, quiet: true },
  ).stdout;
  const resources = [];
  yaml.loadAll(rendered, (resource) => {
    if (resource) resources.push(resource);
  });
  const cluster = resources.find(
    (resource) =>
      resource.kind === 'Cluster' &&
      resource.metadata?.name === POSTGRES_CLUSTER,
  );
  assert.ok(cluster, 'CloudNativePG Cluster resource is unavailable');
  cluster.spec.storage.storageClass = FIXTURE_STORAGE_CLASS;
  cluster.spec.walStorage.storageClass = FIXTURE_STORAGE_CLASS;
  for (const resource of resources) fixture.apply(resource);
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

function postgresPods(fixture) {
  return fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    `cnpg.io/cluster=${POSTGRES_CLUSTER}`,
  ]).items;
}

function currentPrimaryPod(fixture) {
  const name = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'cluster',
    POSTGRES_CLUSTER,
  ]).status?.currentPrimary;
  assert.ok(name, 'CloudNativePG current primary is unavailable');
  return fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pod', name]);
}

function providerPods(fixture) {
  return fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    `app.kubernetes.io/name=${PROVIDER_NAME}`,
  ]).items;
}

async function readyProviderPodForGeneration(
  fixture,
  expectedGeneration,
  timeoutMs = 60_000,
) {
  assert.match(expectedGeneration, /^[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return (
    await waitFor(
      `provider generation ${expectedGeneration}`,
      timeoutMs,
      () => {
        const ready = providerPods(fixture).filter(podReady);
        const matching = ready.filter(
          (pod) =>
            pod.metadata.annotations?.['qinglong.io/provider-generation'] ===
            expectedGeneration,
        );
        return matching.length === 1
          ? { ready: true, value: matching[0] }
          : {
              ready: false,
              fact: `${matching.length} matching of ${ready.length} Ready provider Pods`,
            };
      },
    )
  ).value;
}

function providerObservationKey(pod) {
  assert.match(pod?.metadata?.uid ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]+$/);
  const provider = pod?.status?.containerStatuses?.find(
    (container) => container.name === 'provider',
  );
  assert.ok(provider);
  assert.ok(
    Number.isSafeInteger(provider.restartCount) && provider.restartCount >= 0,
  );
  return `${pod.metadata.uid}:${provider.restartCount}`;
}

function applyExecutorNetworkPolicy(fixture, providerPodIp) {
  const egress = [
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
          },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    {
      to: [
        {
          podSelector: {
            matchLabels: { 'cnpg.io/cluster': POSTGRES_CLUSTER },
          },
        },
      ],
      ports: [{ protocol: 'TCP', port: 5432 }],
    },
  ];
  if (providerPodIp) {
    assert.match(providerPodIp, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    egress.push({
      to: [{ ipBlock: { cidr: `${providerPodIp}/32` } }],
      ports: [{ protocol: 'TCP', port: PROVIDER_PORT }],
    });
  }
  fixture.apply({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'ql3-provider-credential-test-executor',
      namespace: NAMESPACE,
    },
    spec: {
      podSelector: {
        matchLabels: {
          'app.kubernetes.io/name': 'ql3-provider-credential-test-executor',
          'app.kubernetes.io/component': 'provider-credential-test-executor',
        },
      },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress,
    },
  });
}

function applyActorNetworkPolicy(fixture) {
  fixture.apply({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'ql3-provider-credential-test-live-actor',
      namespace: NAMESPACE,
    },
    spec: {
      podSelector: {
        matchLabels: {
          'app.kubernetes.io/name': 'ql3-provider-credential-test-live-actor',
        },
      },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'kube-system',
                },
              },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        {
          to: [
            {
              podSelector: {
                matchLabels: { 'cnpg.io/cluster': POSTGRES_CLUSTER },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: 5432 }],
        },
      ],
    },
  });
}

function providerServerSource() {
  return String.raw`
const fs=require('node:fs');const https=require('node:https');
const expected=process.env.QL3_PROVIDER_VALUE;const generation=process.env.QL3_PROVIDER_GENERATION;let requestCount=0;
const server=https.createServer({key:fs.readFileSync('/var/run/provider/tls.key'),cert:fs.readFileSync('/var/run/provider/tls.crt')},(request,response)=>{
  if(request.url==='/healthz'){response.writeHead(200);response.end('ok');return;}
  if(request.method==='GET'&&request.url==='/evidence'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({schemaVersion:1,generation,requestCount}));return;}
  if(request.method!=='GET'||request.url!=='/v1/models'){response.writeHead(404);response.end();return;}
  requestCount+=1;
  const allowed=request.headers.authorization===('Bearer '+expected);
  process.stdout.write(JSON.stringify({event:'provider_request',generation,allowed})+'\\n');
  response.writeHead(allowed?200:401,{'content-type':'application/json'});
  response.end(JSON.stringify(allowed?{data:[{id:'live-model-a'},{id:'live-model-b'}]}:{error:{code:'unauthorized'}}));
});server.listen(8443,'0.0.0.0');`;
}

async function deployProvider(fixture, adminImage, generation, value, nonce) {
  const expectedGeneration = `${generation}-${nonce}`;
  applySecret(fixture, 'ql3-provider-live-authority', 'Opaque', {
    value,
  });
  fixture.apply({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: PROVIDER_NAME, namespace: NAMESPACE },
    spec: {
      replicas: 1,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      },
      selector: { matchLabels: { 'app.kubernetes.io/name': PROVIDER_NAME } },
      template: {
        metadata: {
          labels: { 'app.kubernetes.io/name': PROVIDER_NAME },
          annotations: {
            'qinglong.io/provider-generation': expectedGeneration,
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'provider',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: ['node', '-e', providerServerSource()],
              env: [
                {
                  name: 'QL3_PROVIDER_VALUE',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ql3-provider-live-authority',
                      key: 'value',
                    },
                  },
                },
                { name: 'QL3_PROVIDER_GENERATION', value: String(generation) },
              ],
              ports: [{ name: 'https', containerPort: PROVIDER_PORT }],
              readinessProbe: {
                httpGet: { scheme: 'HTTPS', path: '/healthz', port: 'https' },
                periodSeconds: 1,
                timeoutSeconds: 1,
                failureThreshold: 30,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '5m', memory: '24Mi' },
                limits: { cpu: '200m', memory: '96Mi' },
              },
              volumeMounts: [
                { name: 'tls', mountPath: '/var/run/provider', readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: 'tls', secret: { secretName: 'ql3-provider-live-tls' } },
          ],
        },
      },
    },
  });
  fixture.apply({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: PROVIDER_NAME, namespace: NAMESPACE },
    spec: {
      clusterIP: 'None',
      selector: { 'app.kubernetes.io/name': PROVIDER_NAME },
      ports: [{ name: 'https', port: PROVIDER_PORT, targetPort: 'https' }],
    },
  });
  fixture.apply({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: PROVIDER_NAME, namespace: NAMESPACE },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': PROVIDER_NAME } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  'app.kubernetes.io/name':
                    'ql3-provider-credential-test-executor',
                  'app.kubernetes.io/component':
                    'provider-credential-test-executor',
                },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: PROVIDER_PORT }],
        },
      ],
      egress: [],
    },
  });
  fixture.kubectl([
    '-n',
    NAMESPACE,
    'rollout',
    'status',
    `deployment/${PROVIDER_NAME}`,
    '--timeout=3m',
  ]);
  const ready = await readyProviderPodForGeneration(
    fixture,
    expectedGeneration,
  );
  assert.match(ready.status.podIP, /^\d{1,3}(?:\.\d{1,3}){3}$/);
  return ready;
}

async function waitForJob(fixture, name, timeoutMs = 120_000) {
  return (
    await waitFor(`${name} terminal`, timeoutMs, () => {
      const job = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
      const complete = job.status.conditions?.some(
        (condition) =>
          condition.type === 'Complete' && condition.status === 'True',
      );
      const failed = job.status.conditions?.some(
        (condition) =>
          condition.type === 'Failed' && condition.status === 'True',
      );
      return complete || failed
        ? { ready: true, value: { job, complete, failed } }
        : { ready: false, fact: JSON.stringify(job.status ?? {}) };
    })
  ).value;
}

async function terminalJobPod(fixture, name, timeoutMs = 60_000) {
  return (
    await waitFor(`${name} terminal Pod`, timeoutMs, () => {
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
        : { ready: false, fact: `${pods.length} Pods observed` };
    })
  ).value;
}

async function terminalJobSnapshot(fixture, name, timeoutMs = 120_000) {
  const [pod, terminal] = await Promise.all([
    terminalJobPod(fixture, name, timeoutMs),
    waitForJob(fixture, name, timeoutMs),
  ]);
  return Object.freeze({ pod, terminal });
}

function actorJob(adminImage, name, commandConfigMap) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 60,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-provider-credential-test-live-actor',
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
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
              name: 'actor',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: ['node', '/opt/live/actor.cjs'],
              terminationMessagePolicy: 'FallbackToLogsOnError',
              env: [
                {
                  name: 'NODE_PATH',
                  value: '/opt/qinglong/node_modules',
                },
                {
                  name: 'QL3_LIVE_ACTOR_COMMAND_FILE',
                  value: '/var/run/live/command.json',
                },
                {
                  name: 'QL3_LIVE_POSTGRES_HOST',
                  value: `ql3-postgres-rw.${NAMESPACE}.svc`,
                },
                { name: 'QL3_LIVE_POSTGRES_PORT', value: '5432' },
                { name: 'QL3_LIVE_POSTGRES_DATABASE', value: 'qinglong' },
                {
                  name: 'QL3_LIVE_POSTGRES_USER',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ql3-postgres-ai-credential-manager-auth',
                      key: 'username',
                    },
                  },
                },
                {
                  name: 'QL3_LIVE_POSTGRES_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ql3-postgres-ai-credential-manager-auth',
                      key: 'password',
                    },
                  },
                },
                {
                  name: 'QL3_LIVE_POSTGRES_TLS_SERVERNAME',
                  value: `ql3-postgres-rw.${NAMESPACE}.svc`,
                },
                {
                  name: 'QL3_LIVE_POSTGRES_CA_FILE',
                  value: '/var/run/postgres/ca.crt',
                },
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
              volumeMounts: [
                { name: 'actor', mountPath: '/opt/live', readOnly: true },
                {
                  name: 'command',
                  mountPath: '/var/run/live/command.json',
                  subPath: 'command.json',
                  readOnly: true,
                },
                {
                  name: 'postgres-ca',
                  mountPath: '/var/run/postgres',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'actor',
              configMap: {
                name: 'ql3-provider-credential-test-live-actor',
                defaultMode: 292,
              },
            },
            {
              name: 'command',
              configMap: { name: commandConfigMap, defaultMode: 292 },
            },
            {
              name: 'postgres-ca',
              secret: {
                secretName: 'ql3-postgres-ca',
                defaultMode: 292,
                items: [{ key: 'ca.crt', path: 'ca.crt' }],
              },
            },
          ],
        },
      },
    },
  };
}

async function runActor(fixture, adminImage, name, command) {
  const commandConfigMap = `${name}-command`;
  fixture.apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: commandConfigMap, namespace: NAMESPACE },
    data: { 'command.json': JSON.stringify(command) },
  });
  fixture.create(actorJob(adminImage, name, commandConfigMap));
  const { pod, terminal } = await terminalJobSnapshot(fixture, name);
  const state = pod.status.containerStatuses[0].state.terminated;
  assert.equal(terminal.complete, true, state.message);
  assert.equal(terminal.failed, false, state.message);
  assert.equal(state.exitCode, 0, state.message);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(
    pod.spec.volumes.some((volume) =>
      /provider-credential-test-material/.test(volume.secret?.secretName ?? ''),
    ),
    false,
  );
  const result = JSON.parse(state.message);
  fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'delete',
      `job/${name}`,
      `configmap/${commandConfigMap}`,
      '--wait=false',
    ],
    { capture: true, quiet: true },
  );
  return result;
}

function renderExecutorResources(fixture, adminImage) {
  const rendered = localManifest(
    fixture.kubectl(
      [
        'kustomize',
        'deploy/kubernetes/ql3-cluster/operations/provider-credential-test-executor/cloudnative-pg',
      ],
      { capture: true, quiet: true },
    ).stdout,
    'registry.example.com/qinglong/qinglong3-cluster-admin',
    adminImage,
  );
  const items = [];
  yaml.loadAll(rendered, (item) => {
    if (item) items.push(item);
  });
  const serviceAccount = items.find((item) => item.kind === 'ServiceAccount');
  const networkPolicy = items.find((item) => item.kind === 'NetworkPolicy');
  const job = items.find((item) => item.kind === 'Job');
  assert.ok(serviceAccount && networkPolicy && job);
  fixture.apply(serviceAccount);
  fixture.apply(networkPolicy);
  return job;
}

function findNamed(value, name) {
  const selected = value.find((entry) => entry.name === name);
  assert.ok(selected, `${name} is absent`);
  return selected;
}

function executorJob({
  template,
  adminImage,
  name,
  commandConfigMap,
  allowlistConfigMap,
  materialFileName,
}) {
  const job = structuredClone(template);
  job.metadata.name = name;
  delete job.metadata.resourceVersion;
  delete job.metadata.uid;
  job.spec.template.metadata.labels['ql3.live/test-job'] = name;
  const container = job.spec.template.spec.containers[0];
  container.image = adminImage;
  container.terminationMessagePolicy = 'FallbackToLogsOnError';
  container.env.push({
    name: 'NODE_EXTRA_CA_CERTS',
    value: '/var/run/secrets/qinglong3/provider-ca/ca.crt',
  });
  container.volumeMounts.push({
    name: 'provider-ca',
    mountPath: '/var/run/secrets/qinglong3/provider-ca',
    readOnly: true,
  });
  const command = findNamed(job.spec.template.spec.volumes, 'command');
  command.projected.sources[0].configMap.name = commandConfigMap;
  command.projected.sources[1].configMap.name = allowlistConfigMap;
  const material = findNamed(job.spec.template.spec.volumes, 'provider-secret');
  material.secret.items = [{ key: materialFileName, path: materialFileName }];
  job.spec.template.spec.volumes.push({
    name: 'provider-ca',
    secret: {
      secretName: 'ql3-provider-live-tls',
      defaultMode: 292,
      items: [{ key: 'ca.crt', path: 'ca.crt' }],
    },
  });
  return job;
}

function aiFeatureMigrationJob(template, adminImage) {
  const job = structuredClone(template);
  job.metadata.name = 'ql3-ai-feature-migration';
  delete job.metadata.resourceVersion;
  delete job.metadata.uid;
  job.spec.template.metadata.labels['app.kubernetes.io/name'] =
    'ql3-ai-feature-migration';
  job.spec.template.metadata.labels['app.kubernetes.io/component'] =
    'ai-feature-migration';
  const container = job.spec.template.spec.containers[0];
  container.name = 'ai-feature-migration';
  container.image = adminImage;
  container.command = [
    'node',
    '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/modelInvocationMigrationCli.js',
  ];
  return job;
}

async function runExecutor({
  fixture,
  template,
  adminImage,
  name,
  testId,
  executionId,
  allowlist,
  materialFileName,
  forbiddenValues,
}) {
  const commandConfigMap = `${name}-command`;
  const allowlistConfigMap = `${name}-allowlist`;
  fixture.apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: commandConfigMap, namespace: NAMESPACE },
    data: {
      'command.json': JSON.stringify({
        schemaVersion: 1,
        testId,
        executionId,
      }),
    },
  });
  fixture.apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: allowlistConfigMap, namespace: NAMESPACE },
    data: { 'allowlist.json': JSON.stringify(allowlist) },
  });
  fixture.create(
    executorJob({
      template,
      adminImage,
      name,
      commandConfigMap,
      allowlistConfigMap,
      materialFileName,
    }),
  );
  const { pod, terminal } = await terminalJobSnapshot(fixture, name, 150_000);
  const state = pod.status.containerStatuses[0].state.terminated;
  assert.equal(terminal.complete, true, state.message);
  assert.equal(terminal.failed, false, state.message);
  assert.equal(state.exitCode, 0, state.message);
  const output = JSON.parse(state.message);
  assert.equal(output.event, 'execution_completed');
  assert.match(output.outcome, /^(?:reachable|unreachable)$/);
  assert.ok(output.modelCount === null || Number.isInteger(output.modelCount));
  if (output.transportFailureCode !== undefined) {
    assert.match(output.transportFailureCode, /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.match(output.transportRequestDigest, /^sha256:[a-f0-9]{64}$/);
    if (output.transportAddressSha256 !== undefined) {
      assert.match(output.transportAddressSha256, /^sha256:[a-f0-9]{64}$/);
      assert.ok(
        Number.isInteger(output.transportPort) &&
          output.transportPort >= 1 &&
          output.transportPort <= 65_535,
      );
    }
  }
  assert.equal(
    pod.spec.serviceAccountName,
    'ql3-provider-credential-test-executor',
  );
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(
    pod.spec.containers[0].securityContext.readOnlyRootFilesystem,
    true,
  );
  assert.equal(pod.spec.containers[0].resources.requests.memory, '48Mi');
  assert.equal(pod.spec.containers[0].resources.limits.memory, '192Mi');
  for (const forbidden of forbiddenValues) {
    assert.equal(state.message.includes(forbidden), false);
  }
  const result = Object.freeze({
    outcome: output.outcome,
    status: output.status,
    modelCount: output.modelCount,
    durationMs: output.durationMs,
    transportFailureCode: output.transportFailureCode ?? null,
    transportRequestDigest: output.transportRequestDigest ?? null,
    transportAddressSha256: output.transportAddressSha256 ?? null,
    transportPort: output.transportPort ?? null,
    podUid: pod.metadata.uid,
    nodeName: pod.spec.nodeName,
  });
  if (process.env[PRESERVE_FAILURE_ENV] !== '1') {
    fixture.kubectl(
      [
        '-n',
        NAMESPACE,
        'delete',
        `job/${name}`,
        `configmap/${commandConfigMap}`,
        `configmap/${allowlistConfigMap}`,
        '--wait=false',
      ],
      { capture: true, quiet: true },
    );
  }
  return result;
}

async function providerEvidence({
  fixture,
  adminImage,
  name,
  nodeName,
  providerPodIp,
}) {
  assert.match(nodeName, /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/);
  assert.match(
    providerPodIp,
    /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
  );
  const source = String.raw`
const fs=require('node:fs');const https=require('node:https');let finished=false;
const finish=(error,value)=>{if(finished)return;finished=true;if(error){const nested=error&&typeof error==='object'&&error.cause&&typeof error.cause==='object'?error.cause:error;const code=typeof nested.code==='string'?nested.code:(typeof error.name==='string'?error.name:'Error');fs.writeFileSync('/dev/termination-log',JSON.stringify({schemaVersion:1,error:'unavailable',code}),{encoding:'utf8',mode:0o600});process.exitCode=1;return;}fs.writeFileSync('/dev/termination-log',value,{encoding:'utf8',mode:0o600});process.stdout.write(value+'\\n');};
const request=https.get({host:process.argv[1],port:Number(process.argv[2]),path:'/evidence',servername:process.argv[3],ca:fs.readFileSync('/var/run/provider-ca/ca.crt'),rejectUnauthorized:true,timeout:3000},(response)=>{if(response.statusCode!==200){response.resume();finish(Object.assign(new Error('status'),{code:'HTTP_'+response.statusCode}),'');return;}const chunks=[];let total=0;response.on('data',(chunk)=>{total+=chunk.byteLength;if(total>4096){request.destroy(Object.assign(new Error('oversize'),{code:'OVERSIZE'}));return;}chunks.push(chunk);});response.on('end',()=>finish(null,Buffer.concat(chunks,total).toString('utf8')));response.on('error',(error)=>finish(error,''));});
request.on('timeout',()=>request.destroy(Object.assign(new Error('timeout'),{code:'TIMEOUT'})));request.on('error',(error)=>finish(error,''));`;
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 30,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-provider-credential-test-executor',
            'app.kubernetes.io/component': 'provider-credential-test-executor',
            'ql3.live/evidence': 'provider-request-count',
          },
        },
        spec: {
          serviceAccountName: 'ql3-provider-credential-test-executor',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeName,
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'evidence',
              image: adminImage,
              imagePullPolicy: 'Never',
              terminationMessagePolicy: 'FallbackToLogsOnError',
              env: [
                {
                  name: 'NODE_EXTRA_CA_CERTS',
                  value: '/var/run/provider-ca/ca.crt',
                },
              ],
              command: [
                'node',
                '-e',
                source,
                providerPodIp,
                String(PROVIDER_PORT),
                PROVIDER_SERVERNAME,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '5m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
              volumeMounts: [
                {
                  name: 'provider-ca',
                  mountPath: '/var/run/provider-ca',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'provider-ca',
              secret: {
                secretName: 'ql3-provider-live-tls',
                defaultMode: 292,
                items: [{ key: 'ca.crt', path: 'ca.crt' }],
              },
            },
          ],
        },
      },
    },
  });
  const { pod, terminal } = await terminalJobSnapshot(fixture, name, 60_000);
  const state = pod.status.containerStatuses[0].state.terminated;
  assert.equal(terminal.complete, true, state.message);
  assert.equal(terminal.failed, false, state.message);
  assert.equal(state.exitCode, 0, state.message);
  assert.equal(pod.spec.nodeName, nodeName);
  const evidence = JSON.parse(state.message);
  assert.deepEqual(Object.keys(evidence).sort(), [
    'generation',
    'requestCount',
    'schemaVersion',
  ]);
  assert.equal(evidence.schemaVersion, 1);
  assert.match(evidence.generation, /^[12]$/);
  assert.ok(Number.isInteger(evidence.requestCount));
  assert.ok(evidence.requestCount >= 0 && evidence.requestCount <= 5);
  fixture.kubectl(['-n', NAMESPACE, 'delete', `job/${name}`, '--wait=false'], {
    capture: true,
    quiet: true,
  });
  return evidence;
}

async function retryProviderEvidence(read, pause = undefined) {
  assert.equal(typeof read, 'function');
  assert.ok(pause === undefined || typeof pause === 'function');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (
        !/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|TIMEOUT)\b/.test(
          error instanceof Error ? error.message : String(error),
        ) ||
        attempt === 3
      ) {
        throw error;
      }
      await (
        pause ?? (() => new Promise((resolve) => setTimeout(resolve, 500)))
      )();
    }
  }
  throw lastError;
}

async function waitForExecutorProviderEgress({
  fixture,
  adminImage,
  nodes,
  label,
}) {
  const source = String.raw`
const fs=require('node:fs');const deadline=Date.now()+20000;let finished=false;let last='UNAVAILABLE';
const finish=(connected)=>{if(finished)return;finished=true;const value=JSON.stringify(connected?{schemaVersion:1,connected:true}:{schemaVersion:1,connected:false,code:last});fs.writeFileSync('/dev/termination-log',value,{encoding:'utf8',mode:0o600});process.stdout.write(value+'\\n');process.exitCode=connected?0:1;};
const attempt=async()=>{try{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),1000);let response;try{response=await fetch(new URL('https://'+process.argv[1]+':'+process.argv[2]+'/evidence'),{method:'GET',signal:controller.signal,headers:Object.freeze({accept:'application/json','content-type':'application/json',authorization:'Bearer convergence-probe'})});}finally{clearTimeout(timeout);}if(response.status!==200)throw Object.assign(new Error('status'),{code:'HTTP_'+response.status});await response.body?.cancel();finish(true);}catch(error){const nested=error&&typeof error==='object'&&error.cause&&typeof error.cause==='object'?error.cause:error;last=typeof nested?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(nested.code)?nested.code:(error?.name==='AbortError'?'ETIMEDOUT':'UNAVAILABLE');if(Date.now()<deadline)setTimeout(attempt,250);else finish(false);}};attempt();`;
  for (const [index, node] of nodes.entries()) {
    const nodeName = node.metadata?.name;
    assert.match(nodeName, /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/);
    const name = `ql3-provider-converge-${label}-${index + 1}`;
    fixture.create({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace: NAMESPACE },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 30,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'ql3-provider-credential-test-executor',
              'app.kubernetes.io/component':
                'provider-credential-test-executor',
              'ql3.live/evidence': 'network-policy-convergence',
            },
          },
          spec: {
            serviceAccountName: 'ql3-provider-credential-test-executor',
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            nodeName,
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
                terminationMessagePolicy: 'FallbackToLogsOnError',
                env: [
                  {
                    name: 'NODE_EXTRA_CA_CERTS',
                    value: '/var/run/provider-ca/ca.crt',
                  },
                ],
                command: [
                  'node',
                  '-e',
                  source,
                  PROVIDER_SERVERNAME,
                  String(PROVIDER_PORT),
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { cpu: '5m', memory: '16Mi' },
                  limits: { cpu: '100m', memory: '64Mi' },
                },
                volumeMounts: [
                  {
                    name: 'provider-ca',
                    mountPath: '/var/run/provider-ca',
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'provider-ca',
                secret: {
                  secretName: 'ql3-provider-live-tls',
                  defaultMode: 292,
                  items: [{ key: 'ca.crt', path: 'ca.crt' }],
                },
              },
            ],
          },
        },
      },
    });
    const { pod, terminal } = await terminalJobSnapshot(fixture, name, 45_000);
    const state = pod.status.containerStatuses[0].state.terminated;
    assert.equal(terminal.complete, true, state.message);
    assert.equal(terminal.failed, false, state.message);
    assert.equal(state.exitCode, 0, state.message);
    assert.equal(pod.spec.nodeName, nodeName);
    assert.deepEqual(JSON.parse(state.message), {
      schemaVersion: 1,
      connected: true,
    });
    fixture.kubectl(
      ['-n', NAMESPACE, 'delete', `job/${name}`, '--wait=false'],
      {
        capture: true,
        quiet: true,
      },
    );
  }
}

async function tcpProbe({ fixture, adminImage, name, host, port, connected }) {
  const source = String.raw`
const fs=require('node:fs');const net=require('node:net');const deadline=Date.now()+20000;
const connect=(host,port,timeout)=>new Promise((resolve)=>{let settled=false;const socket=net.createConnection({host,port});const finish=(ok,reason)=>{if(settled)return;settled=true;socket.destroy();resolve({ok,reason})};socket.setTimeout(timeout);socket.once('connect',()=>finish(true,'connect'));socket.once('timeout',()=>finish(false,'timeout'));socket.once('error',(error)=>finish(false,error.code||'error'));});
const finish=(result)=>{fs.writeFileSync('/dev/termination-log',result.ok?'connected':('denied:'+result.reason),{encoding:'utf8',mode:0o600});process.exitCode=result.ok?0:1};
(async()=>{const host=process.argv[1];const port=Number(process.argv[2]);const expectedConnected=process.argv[3]==='true';if(expectedConnected){finish(await connect(host,port,3000));return;}while(Date.now()<deadline){const canary=await connect('kubernetes.default.svc',443,250);if(!canary.ok){finish(await connect(host,port,1000));return;}await new Promise((resolve)=>setTimeout(resolve,50));}finish({ok:true,reason:'policy-not-enforced'});})();`;
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 30,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-provider-credential-test-executor',
            'app.kubernetes.io/component': 'provider-credential-test-executor',
          },
        },
        spec: {
          serviceAccountName: 'ql3-provider-credential-test-executor',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
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
                source,
                host,
                String(port),
                String(connected),
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
  const { pod, terminal } = await terminalJobSnapshot(fixture, name, 60_000);
  const state = pod.status.containerStatuses[0].state.terminated;
  assert.equal(terminal.complete, connected, state.message);
  assert.equal(terminal.failed, !connected, state.message);
  assert.equal(state.exitCode === 0, connected, state.message);
  assert.match(state.message ?? '', connected ? /^connected$/ : /^denied:/);
  fixture.kubectl(['-n', NAMESPACE, 'delete', `job/${name}`, '--wait=false'], {
    capture: true,
    quiet: true,
  });
  return true;
}

function canI(fixture, verb, resource) {
  const result = fixture.kubectl(
    [
      'auth',
      'can-i',
      verb,
      resource,
      '--as',
      `system:serviceaccount:${NAMESPACE}:ql3-provider-credential-test-executor`,
      '-n',
      NAMESPACE,
    ],
    { allowFailure: true, capture: true, quiet: true },
  );
  assert.deepEqual(
    [result.status, result.stdout],
    result.stdout === 'yes' ? [0, 'yes'] : [1, 'no'],
    `unexpected kubectl auth can-i response: status=${String(result.status)}`,
  );
  return result.stdout;
}

async function main() {
  if (process.env.QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE=1',
    );
  }
  const operatorManifestFile = process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE;
  if (!operatorManifestFile) {
    throw new Error('QL3_CNPG_OPERATOR_MANIFEST_FILE is required');
  }
  const reviewedManifest = reviewedOperatorManifest(operatorManifestFile);
  const fixture = new K3sDockerLiveFixture({
    prefix: 'ql3-provider-test-live',
  });
  const suffix = `${process.pid.toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const adminImage = `${ADMIN_IMAGE_BASE}:${suffix}`;
  const controlImage = `${CONTROL_IMAGE_BASE}:${suffix}`;
  let adminImageBuilt = false;
  let controlImageBuilt = false;
  let completed = false;
  let stoppedNode = '';
  try {
    const nodes = await fixture.start();
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    assert.ok(['amd64', 'arm64'].includes(architecture));

    for (const [index, reviewedImage] of [
      OPERATOR_IMAGE,
      POSTGRES_IMAGE,
    ].entries()) {
      const cached = fixture.dockerRun(['image', 'inspect', reviewedImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
      if (cached.status !== 0) {
        run(fixture.docker, ['pull', reviewedImage]);
      }
      const inspected = fixture.inspectImage(reviewedImage);
      assert.ok(
        inspected.RepoDigests?.some((entry) =>
          entry.endsWith(`@${imageDigest(reviewedImage)}`),
        ),
      );
      const preloadTag = imageTag(reviewedImage);
      run(fixture.docker, ['tag', reviewedImage, preloadTag]);
      fixture.loadImage(preloadTag, `reviewed-${index}.tar`);
    }

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
    const rolePasswords = new Map();
    for (const role of ROLE_NAMES) {
      const password = randomSecret();
      rolePasswords.set(role, password);
      applySecret(fixture, roleSecretName(role), 'kubernetes.io/basic-auth', {
        username: role,
        password,
      });
    }
    applyFixturePostgresVolumes(fixture);
    applyCloudNativePgResources(fixture);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Ready',
      `cluster/${POSTGRES_CLUSTER}`,
      '--timeout=20m',
    ]);
    const readyDatabase = (
      await waitFor('three CloudNativePG instances', 10 * 60_000, () => {
        const ready = postgresPods(fixture).filter(podReady);
        const distinctNodes = new Set(ready.map((pod) => pod.spec.nodeName));
        return ready.length === 3 && distinctNodes.size === 3
          ? { ready: true, value: ready }
          : {
              ready: false,
              fact: `${ready.length} Ready across ${distinctNodes.size} nodes`,
            };
      })
    ).value;

    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag',
      adminImage,
      '--build-arg',
      `SOURCE_REVISION=${process.env.GITHUB_SHA || 'live-contract'}`,
      '.',
    ]);
    adminImageBuilt = true;
    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-control/Dockerfile',
      '--tag',
      controlImage,
      '--build-arg',
      `SOURCE_REVISION=${process.env.GITHUB_SHA || 'live-contract'}`,
      '.',
    ]);
    controlImageBuilt = true;
    fixture.loadImage(adminImage, 'provider-test-admin.tar');
    fixture.loadImage(controlImage, 'provider-test-migration.tar');

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
    const migrationDocuments = [];
    yaml.loadAll(migrationManifest, (document) => {
      if (document) migrationDocuments.push(document);
    });
    const migrationJobTemplate = migrationDocuments.find(
      (document) => document.kind === 'Job',
    );
    assert.ok(migrationJobTemplate, 'migration Job template is unavailable');
    fixture.kubectl(['create', '-f', '-'], { input: migrationManifest });
    const migration = await waitForJob(
      fixture,
      'ql3-cluster-migration',
      10 * 60_000,
    );
    assert.equal(migration.complete, true);
    fixture.create(aiFeatureMigrationJob(migrationJobTemplate, adminImage));
    const aiMigration = await waitForJob(
      fixture,
      'ql3-ai-feature-migration',
      10 * 60_000,
    );
    assert.equal(aiMigration.complete, true);

    const primary = currentPrimaryPod(fixture);
    const databaseFacts = JSON.parse(
      psql(
        fixture,
        primary.metadata.name,
        `SELECT json_build_object(
           'postgresVersionNumber', current_setting('server_version_num')::integer,
           'migrationCount', (SELECT count(*)::integer FROM "ql3"."schema_migrations"),
           'aiMigrationCount', (SELECT count(*)::integer FROM "ql3_ai"."ai_schema_migrations")
         )::text;`,
      ),
    );
    assert.equal(databaseFacts.postgresVersionNumber, 180004);
    assert.equal(databaseFacts.aiMigrationCount, AI_MIGRATION_COUNT);

    psql(
      fixture,
      primary.metadata.name,
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         '${PROJECT_ID}', '${PROJECT_ID}', '${PROJECT_ID}', 'active', 1, 1, 1
       );
       INSERT INTO "ql3"."project_role_bindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES (
         '${PROJECT_ID}', 'user', '${ACTOR_ID}', 1, 'active', 'owner',
         '${crypto.randomUUID()}', 'system', 'kubernetes-live', 1
       );`,
    );

    fixture.apply({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-provider-credential-test-live-actor',
        namespace: NAMESPACE,
      },
      data: { 'actor.cjs': ACTOR_SOURCE },
    });
    applyActorNetworkPolicy(fixture);
    await runActor(fixture, adminImage, 'ql3-provider-test-bind', {
      schemaVersion: 1,
      action: 'bind',
      projectId: PROJECT_ID,
      provider: PROVIDER,
      actorId: ACTOR_ID,
      secretName: SECRET_NAME,
      mutationId: crypto.randomUUID(),
      requestId: `live-bind-${suffix}`,
      occurredAtMs: Date.now(),
    });

    const pkiDirectory = path.join(fixture.temporary, 'provider-pki');
    fs.mkdirSync(pkiDirectory, { mode: 0o700 });
    const pki = createMutualTlsPki({
      directory: pkiDirectory,
      servername: PROVIDER_SERVERNAME,
      label: 'QL3 Provider Test Live',
      run,
      crypto,
    });
    const providerPki = pki.read();
    applySecret(fixture, 'ql3-provider-live-tls', 'Opaque', {
      'ca.crt': providerPki.ca,
      'tls.crt': providerPki.serverCertificate,
      'tls.key': providerPki.serverKey,
    });
    const materialOne = `live-one-${randomSecret()}`;
    const materialTwo = `live-two-${randomSecret()}`;
    const secretRef = createSecretRef({
      projectId: PROJECT_ID,
      name: SECRET_NAME,
    });
    const materialFileName = projectedModelProviderSecretFileName(secretRef);
    applySecret(fixture, 'ql3-provider-credential-test-material', 'Opaque', {
      [materialFileName]: materialOne,
    });
    let providerPod = await deployProvider(
      fixture,
      adminImage,
      1,
      materialOne,
      'initial',
    );
    const initialProviderUid = providerPod.metadata.uid;
    const allowlist = createModelProviderCredentialTestAllowlist({
      revision: 'kubernetes-live-v1',
      providers: [
        {
          provider: PROVIDER,
          adapter: 'openai-compatible',
          baseUrl: PROVIDER_URL,
          revision: 'private-provider-v1',
          deadlineMs: 3_000,
          maxResponseBytes: 64 * 1024,
          maxModels: 8,
          maxCostMicrousd: 0,
          retryLimit: 0,
        },
      ],
    });
    const executorTemplate = renderExecutorResources(fixture, adminImage);
    const forbiddenValues = [materialOne, materialTwo, secretRef];
    let sequence = 0;
    const plan = async (label) => {
      sequence += 1;
      const testId = crypto.randomUUID();
      const executionId = crypto.randomUUID();
      const now = Date.now();
      await runActor(fixture, adminImage, `ql3-provider-plan-${sequence}`, {
        schemaVersion: 1,
        action: 'plan',
        projectId: PROJECT_ID,
        provider: PROVIDER,
        actorId: ACTOR_ID,
        testId,
        requestId: `live-${label}-${suffix}`,
        allowlist,
        occurredAtMs: now,
        expiresAtMs: now + 5 * 60_000,
      });
      return { testId, executionId };
    };
    const execute = async (label, identity) =>
      runExecutor({
        fixture,
        template: executorTemplate,
        adminImage,
        name: `ql3-provider-test-${label}`,
        ...identity,
        allowlist,
        materialFileName,
        forbiddenValues,
      });

    const requestObservations = new Map();
    let observedProviderRequests = 0;
    let evidenceSequence = 0;
    const observeProvider = async (pod, sourceNodeName) => {
      const expectedGeneration =
        pod.metadata.annotations?.['qinglong.io/provider-generation'];
      assert.match(
        expectedGeneration ?? '',
        /^[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*$/,
      );
      let currentPod;
      const evidence = await retryProviderEvidence(async () => {
        currentPod = await readyProviderPodForGeneration(
          fixture,
          expectedGeneration,
        );
        applyExecutorNetworkPolicy(fixture, currentPod.status.podIP);
        evidenceSequence += 1;
        return providerEvidence({
          fixture,
          adminImage,
          name: `ql3-provider-evidence-${evidenceSequence}`,
          nodeName: sourceNodeName,
          providerPodIp: currentPod.status.podIP,
        });
      });
      assert.ok(currentPod);
      const count = evidence.requestCount;
      const observationKey = providerObservationKey(currentPod);
      const previous = requestObservations.get(observationKey) ?? 0;
      assert.ok(count >= previous);
      observedProviderRequests += count - previous;
      requestObservations.set(observationKey, count);
      return currentPod;
    };

    applyExecutorNetworkPolicy(fixture, null);
    const baseIdentity = await plan('base-denied');
    const baseDenied = await execute('base-denied', baseIdentity);
    providerPod = await observeProvider(providerPod, baseDenied.nodeName);
    assert.equal(observedProviderRequests, 0);
    assert.equal(baseDenied.outcome, 'unreachable');
    assert.equal(baseDenied.modelCount, null);

    applyExecutorNetworkPolicy(fixture, providerPod.status.podIP);
    await waitForExecutorProviderEgress({
      fixture,
      adminImage,
      nodes,
      label: 'exact-allowed',
    });
    const allowedIdentity = await plan('exact-allowed');
    const exactAllowed = await execute('exact-allowed', allowedIdentity);
    const exactReplay = await execute('exact-replay', allowedIdentity);
    assert.equal(exactReplay.status, 'existing');
    providerPod = await observeProvider(providerPod, exactAllowed.nodeName);
    const exactCredentialAuditCount = Number(
      psql(
        fixture,
        currentPrimaryPod(fixture).metadata.name,
        `SELECT count(*)::integer
           FROM "ql3_ai"."model_provider_credential_audits"
          WHERE project_id='${PROJECT_ID}'
            AND provider='${PROVIDER}'
            AND request_id='${allowedIdentity.executionId}'
            AND operation='list_models';`,
      ),
    );
    assert.equal(
      observedProviderRequests,
      1,
      JSON.stringify({
        credentialAuditCount: exactCredentialAuditCount,
        durationMs: exactAllowed.durationMs,
        transportFailureCode: exactAllowed.transportFailureCode,
        transportRequestDigest: exactAllowed.transportRequestDigest,
        transportAddressSha256: exactAllowed.transportAddressSha256,
        expectedProviderAddressSha256: sha256(providerPod.status.podIP),
        transportPort: exactAllowed.transportPort,
      }),
    );
    assert.equal(exactAllowed.outcome, 'reachable');
    assert.equal(exactAllowed.modelCount, 2);
    assert.equal(exactReplay.outcome, 'reachable');
    assert.equal(exactReplay.modelCount, 2);

    providerPod = await deployProvider(
      fixture,
      adminImage,
      2,
      materialTwo,
      'material-rotation',
    );
    applyExecutorNetworkPolicy(fixture, providerPod.status.podIP);
    await waitForExecutorProviderEgress({
      fixture,
      adminImage,
      nodes,
      label: 'material-rotation',
    });
    const staleMaterialIdentity = await plan('stale-material');
    const staleMaterial = await execute(
      'stale-material',
      staleMaterialIdentity,
    );
    applySecret(fixture, 'ql3-provider-credential-test-material', 'Opaque', {
      [materialFileName]: materialTwo,
    });
    const rotatedIdentity = await plan('rotated-material');
    const rotatedMaterial = await execute('rotated-material', rotatedIdentity);
    providerPod = await observeProvider(providerPod, rotatedMaterial.nodeName);
    assert.equal(observedProviderRequests, 3);
    assert.equal(staleMaterial.outcome, 'unreachable');
    assert.equal(staleMaterial.modelCount, null);
    assert.equal(rotatedMaterial.outcome, 'reachable');
    assert.equal(rotatedMaterial.modelCount, 2);

    const cidrBeforeReplacement = providerPod.status.podIP;
    providerPod = await deployProvider(
      fixture,
      adminImage,
      2,
      materialTwo,
      'cidr-rotation',
    );
    assert.notEqual(providerPod.status.podIP, cidrBeforeReplacement);
    const staleCidrIdentity = await plan('stale-cidr');
    const staleCidr = await execute('stale-cidr', staleCidrIdentity);
    providerPod = await observeProvider(providerPod, staleCidr.nodeName);
    assert.equal(observedProviderRequests, 3);
    assert.equal(staleCidr.outcome, 'unreachable');
    assert.equal(staleCidr.modelCount, null);
    applyExecutorNetworkPolicy(fixture, providerPod.status.podIP);
    await waitForExecutorProviderEgress({
      fixture,
      adminImage,
      nodes,
      label: 'cidr-rotation',
    });
    const refreshedIdentity = await plan('refreshed-cidr');
    const refreshedCidr = await execute('refreshed-cidr', refreshedIdentity);
    providerPod = await observeProvider(providerPod, refreshedCidr.nodeName);
    assert.equal(observedProviderRequests, 4);
    assert.equal(refreshedCidr.outcome, 'reachable');
    assert.equal(refreshedCidr.modelCount, 2);

    const cloudNativePgEgressAllowed = await tcpProbe({
      fixture,
      adminImage,
      name: 'ql3-provider-probe-postgres',
      host: `ql3-postgres-rw.${NAMESPACE}.svc`,
      port: 5432,
      connected: true,
    });
    const kubernetesApiEgressDenied = await tcpProbe({
      fixture,
      adminImage,
      name: 'ql3-provider-probe-kube-api',
      host: 'kubernetes.default.svc',
      port: 443,
      connected: false,
    });
    const publicInternetEgressDenied = await tcpProbe({
      fixture,
      adminImage,
      name: 'ql3-provider-probe-public',
      host: '1.1.1.1',
      port: 443,
      connected: false,
    });

    const oldPrimary = currentPrimaryPod(fixture);
    assert.notEqual(
      oldPrimary.spec.nodeName,
      fixture.server,
      'refusing to stop the single K3s control-plane node',
    );
    stoppedNode = oldPrimary.spec.nodeName;
    fixture.stopNode(stoppedNode);
    const promoted = (
      await waitFor('CloudNativePG primary promotion', 10 * 60_000, () => {
        const cluster = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'cluster',
          POSTGRES_CLUSTER,
        ]);
        const current = cluster.status?.currentPrimary;
        const ready = Number(cluster.status?.readyInstances ?? 0);
        return current && current !== oldPrimary.metadata.name && ready >= 2
          ? { ready: true, value: current }
          : {
              ready: false,
              fact: `primary=${current ?? 'none'} ready=${ready}`,
            };
      })
    ).value;
    assert.notEqual(promoted, oldPrimary.metadata.name);
    fixture.startNode(stoppedNode);
    await waitFor('restarted K3s node', 5 * 60_000, () => {
      const node = fixture.kubectlJson(['get', 'node', stoppedNode]);
      const ready = node.status.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      );
      return ready
        ? { ready: true, value: true }
        : { ready: false, fact: 'node is not Ready' };
    });
    stoppedNode = '';
    await waitFor(
      'three recovered CloudNativePG instances',
      15 * 60_000,
      () => {
        const ready = postgresPods(fixture).filter(podReady);
        return ready.length === 3
          ? { ready: true, value: ready }
          : { ready: false, fact: `${ready.length}/3 Ready` };
      },
    );
    fixture.loadImage(adminImage, 'provider-test-admin-post-failover.tar');
    providerPod = (
      await waitFor('provider after database failover', 5 * 60_000, () => {
        const ready = providerPods(fixture).filter(podReady);
        return ready.length === 1
          ? { ready: true, value: ready[0] }
          : { ready: false, fact: `${ready.length}/1 Ready` };
      })
    ).value;
    applyExecutorNetworkPolicy(fixture, providerPod.status.podIP);
    await waitForExecutorProviderEgress({
      fixture,
      adminImage,
      nodes,
      label: 'post-failover',
    });
    const postFailoverIdentity = await plan('post-failover');
    const postFailover = await execute('post-failover', postFailoverIdentity);
    providerPod = await observeProvider(providerPod, postFailover.nodeName);
    assert.equal(observedProviderRequests, 5);
    assert.equal(postFailover.outcome, 'reachable');
    assert.equal(postFailover.modelCount, 2);

    const promotedPrimary = currentPrimaryPod(fixture);
    const durable = JSON.parse(
      psql(
        fixture,
        promotedPrimary.metadata.name,
        `SELECT json_build_object(
           'planCount', (SELECT count(*)::integer FROM "ql3_ai"."model_provider_credential_test_plans" WHERE project_id='${PROJECT_ID}'),
           'executionCount', (SELECT count(*)::integer FROM "ql3_ai"."model_provider_credential_test_executions" AS execution JOIN "ql3_ai"."model_provider_credential_test_plans" AS plan USING (test_id) WHERE plan.project_id='${PROJECT_ID}'),
           'resultCount', (SELECT count(*)::integer FROM "ql3_ai"."model_provider_credential_test_results" AS result JOIN "ql3_ai"."model_provider_credential_test_plans" AS plan USING (test_id) WHERE plan.project_id='${PROJECT_ID}'),
           'credentialUseAuditCount', (SELECT count(*)::integer FROM "ql3_ai"."model_provider_credential_audits" WHERE project_id='${PROJECT_ID}' AND operation='list_models'),
           'planAuditCount', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE project_id='${PROJECT_ID}' AND operation_id='model_provider_credential.test.plan'),
           'reachableCount', (SELECT count(*)::integer FROM "ql3_ai"."model_provider_credential_test_results" AS result JOIN "ql3_ai"."model_provider_credential_test_plans" AS plan USING (test_id) WHERE plan.project_id='${PROJECT_ID}' AND result.outcome='reachable'),
           'unreachableCount', (SELECT count(*)::integer FROM "ql3_ai"."model_provider_credential_test_results" AS result JOIN "ql3_ai"."model_provider_credential_test_plans" AS plan USING (test_id) WHERE plan.project_id='${PROJECT_ID}' AND result.outcome='unreachable'),
           'privateMaterialAbsent', NOT EXISTS (
             SELECT 1 FROM "ql3_ai"."model_provider_credential_test_plans" WHERE project_id='${PROJECT_ID}' AND (plan_json::text LIKE '%${materialOne}%' OR plan_json::text LIKE '%${materialTwo}%' OR plan_json::text LIKE '%secretRef%')
           ) AND NOT EXISTS (
             SELECT 1 FROM "ql3_ai"."model_provider_credential_test_executions" AS execution JOIN "ql3_ai"."model_provider_credential_test_plans" AS plan USING (test_id) WHERE plan.project_id='${PROJECT_ID}' AND (execution.execution_json::text LIKE '%${materialOne}%' OR execution.execution_json::text LIKE '%${materialTwo}%' OR execution.execution_json::text LIKE '%secretRef%')
           ) AND NOT EXISTS (
             SELECT 1 FROM "ql3_ai"."model_provider_credential_test_results" AS result JOIN "ql3_ai"."model_provider_credential_test_plans" AS plan USING (test_id) WHERE plan.project_id='${PROJECT_ID}' AND (result.result_json::text LIKE '%${materialOne}%' OR result.result_json::text LIKE '%${materialTwo}%' OR result.result_json::text LIKE '%secretRef%')
           ) AND NOT EXISTS (
             SELECT 1 FROM "ql3_ai"."model_provider_credential_audits" WHERE project_id='${PROJECT_ID}' AND (audit_json::text LIKE '%${materialOne}%' OR audit_json::text LIKE '%${materialTwo}%' OR audit_json::text LIKE '%secretRef%')
           )
         )::text;`,
      ),
    );
    assert.deepEqual(durable, {
      planCount: 7,
      executionCount: 7,
      resultCount: 7,
      credentialUseAuditCount: 5,
      planAuditCount: 7,
      reachableCount: 4,
      unreachableCount: 3,
      privateMaterialAbsent: true,
    });

    const rolesLeastPrivilege =
      psql(
        fixture,
        promotedPrimary.metadata.name,
        `SELECT bool_and(NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
           FROM pg_roles
          WHERE rolname IN ('ql3_ai_credential_manager','ql3_ai_credential_tester');`,
      ) === 't';
    assert.equal(rolesLeastPrivilege, true);
    assert.equal(canI(fixture, 'get', 'secrets'), 'no');
    assert.equal(canI(fixture, 'patch', 'deployments.apps'), 'no');

    const version = fixture.kubectlJson(['version']);
    const currentProviderPod = providerPods(fixture).filter(podReady)[0];
    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: {
        distribution: 'k3s',
        kubernetesVersion: version.serverVersion.gitVersion,
        architecture,
        kubernetesImageId: imageIdDigest(
          fixture.inspectImage(fixture.k3sImage),
        ),
        adminImageId: imageIdDigest(fixture.inspectImage(adminImage)),
        cniName: 'flannel',
        cniDistributionBinding: 'rancher/k3s:v1.34.3-k3s1',
        controlPlaneNodes: 1,
        workerNodes: 2,
        cniReadyNodes: nodes.length,
      },
      database: {
        operator: 'cloudnative-pg',
        operatorVersion: OPERATOR_VERSION,
        postgresVersionNumber: databaseFacts.postgresVersionNumber,
        postgresImageId: imageIdDigest(fixture.inspectImage(POSTGRES_IMAGE)),
        instances: 3,
        readyInstances: postgresPods(fixture).filter(podReady).length,
        managerRole: 'ql3_ai_credential_manager',
        testerRole: 'ql3_ai_credential_tester',
        migrationCount: databaseFacts.migrationCount,
        aiMigrationCount: databaseFacts.aiMigrationCount,
        tlsVerified: true,
        primaryChangedDuringFailover:
          promotedPrimary.metadata.name !== oldPrimary.metadata.name,
      },
      provider: {
        protocol: 'HTTPS',
        service: PROVIDER_NAME,
        port: PROVIDER_PORT,
        replicas: 1,
        initialPodIdentitySha256: sha256(initialProviderUid),
        rotatedPodIdentitySha256: sha256(currentProviderPod.metadata.uid),
        caSha256: sha256(providerPki.ca),
        modelCount: 2,
        requestCount: observedProviderRequests,
        materialGenerationCount: 2,
        exactPrivateCidrPolicy: true,
      },
      executor: {
        binary: 'ql3-provider-credential-test-execute',
        callerDrivenJobs: true,
        jobsRun: 8,
        backoffLimit: executorTemplate.spec.backoffLimit,
        activeDeadlineSeconds: executorTemplate.spec.activeDeadlineSeconds,
        ttlSecondsAfterFinished: executorTemplate.spec.ttlSecondsAfterFinished,
        serviceAccount: 'ql3-provider-credential-test-executor',
        serviceAccountTokenMounted: false,
        rbacGranted: false,
        poolMaxConnections: 1,
        responseRedacted: true,
        outcomes: {
          baseDenied: baseDenied.outcome,
          exactAllowed: exactAllowed.outcome,
          exactReplay: exactReplay.outcome,
          postFailover: postFailover.outcome,
          refreshedCidr: refreshedCidr.outcome,
          rotatedMaterial: rotatedMaterial.outcome,
          staleCidr: staleCidr.outcome,
          staleMaterial: staleMaterial.outcome,
        },
      },
      rotation: {
        newPodObservedNewProjection: rotatedMaterial.outcome === 'reachable',
        oldMaterialRejectedAfterRotation:
          staleMaterial.outcome === 'unreachable',
        projectedMaterialReresolved:
          staleMaterial.outcome === 'unreachable' &&
          rotatedMaterial.outcome === 'reachable',
        providerPodReplaced:
          initialProviderUid !== currentProviderPod.metadata.uid,
        staleCidrFailedClosed: staleCidr.outcome === 'unreachable',
      },
      isolation: {
        baseProviderEgressDenied: baseDenied.outcome === 'unreachable',
        cloudNativePgEgressAllowed,
        exactProviderEgressAllowed: exactAllowed.outcome === 'reachable',
        kubernetesApiEgressDenied,
        managerMountedNoProviderMaterial: true,
        publicInternetEgressDenied,
        staleProviderCidrDenied: staleCidr.outcome === 'unreachable',
        testerMutationRbacDenied: true,
      },
      durability: {
        planCount: durable.planCount,
        executionCount: durable.executionCount,
        resultCount: durable.resultCount,
        credentialUseAuditCount: durable.credentialUseAuditCount,
        planAuditCount: durable.planAuditCount,
        reachableCount: durable.reachableCount,
        unreachableCount: durable.unreachableCount,
        providerRequestCount: observedProviderRequests,
        replayDuplicateCount: exactReplay.status === 'existing' ? 0 : 1,
        survivedCloudNativePgFailover: true,
      },
      gates: {
        contentFreeEvidence: durable.privateMaterialAbsent,
        durableFactsSurvivedFailover: true,
        exactPrivateProviderEgress:
          exactAllowed.outcome === 'reachable' &&
          staleCidr.outcome === 'unreachable' &&
          refreshedCidr.outcome === 'reachable',
        leastPrivilege: rolesLeastPrivilege,
        passed: true,
        projectedMaterialRotation:
          staleMaterial.outcome === 'unreachable' &&
          rotatedMaterial.outcome === 'reachable',
        realCniPolicy: true,
        realThreeNodeKubernetes: nodes.length === 3,
        eightOneShotJobs: true,
        threeInstanceCloudNativePg: readyDatabase.length === 3,
      },
      limitations: [...LIMITATIONS],
    };
    const audit = validateProviderCredentialTestKubernetesLiveReport(report);
    assert.deepEqual(audit.findings, []);
    completed = true;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (stoppedNode) fixture.startNode(stoppedNode);
    const preserveFailure =
      !completed && process.env[PRESERVE_FAILURE_ENV] === '1';
    if (preserveFailure) {
      process.stderr.write(
        `${JSON.stringify({
          schemaVersion: 1,
          event: 'live_fixture_preserved',
          kubeconfig: fixture.kubeconfig,
          nodes: fixture.nodes,
          network: fixture.network,
          adminImage,
          controlImage,
        })}\n`,
      );
    } else {
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
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `QL3 provider credential test Kubernetes live contract failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  actorJob,
  aiFeatureMigrationJob,
  applyCloudNativePgResources,
  applyExecutorNetworkPolicy,
  applyFixturePostgresVolumes,
  canI,
  deployProvider,
  executorJob,
  providerObservationKey,
  providerServerSource,
  readyProviderPodForGeneration,
  retryProviderEvidence,
  terminalJobSnapshot,
};
