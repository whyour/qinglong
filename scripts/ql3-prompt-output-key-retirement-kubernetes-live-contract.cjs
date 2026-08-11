#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  canonicalPluginPackagePromptOutputKeyringManifest,
  parsePluginPackagePromptOutputKeyringManifest,
  pluginPackagePromptOutputKeyringCatalogDigest,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyringManifest.js');
const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const {
  imageDigest,
  imageTag,
  reviewedOperatorManifest,
} = require('./ql3-cloudnativepg-live-contract.cjs');
const {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputKeyRetirementKubernetesLiveReport,
} = require('./ql3-prompt-output-key-retirement-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const POSTGRES_CLUSTER = 'ql3-postgres';
const KEYRING_SECRET = 'ql3-prompt-output-keyring';
const KEYRING_DATA_KEY = 'keyring.json';
const RETIREMENT_JOB = 'ql3-prompt-output-key-retirement';
const RETIREMENT_SERVICE_ACCOUNT = RETIREMENT_JOB;
const COMMAND_CONFIG_MAP = 'ql3-prompt-output-key-retirement-command';
const DENY_CANARY = 'ql3-retirement-deny-canary';
const DENY_CANARY_PORT = 9443;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const ADMIN_IMAGE_BASE = 'ql3-key-retirement-live-admin';
const CONTROL_IMAGE_BASE = 'ql3-key-retirement-live-migration';
const PRESERVE_FAILURE_ENV =
  'QL3_PROMPT_OUTPUT_KEY_RETIREMENT_KUBERNETES_LIVE_PRESERVE_FAILURE';
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
  'ql3_worker_credential_manager',
  'ql3_worker_credential_executor',
  'ql3_worker_ingress',
]);

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function roleSecretName(role) {
  return `ql3-postgres-${role.replace(/^ql3_/, '').replaceAll('_', '-')}-auth`;
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

function localManifest(rendered, imageName, localImage, expectedMatches = 1) {
  const placeholder = `${imageName}@${ZERO_DIGEST}`;
  const matches = rendered.split(placeholder).length - 1;
  assert.equal(
    matches,
    expectedMatches,
    `expected ${String(expectedMatches)} ${imageName} image placeholders`,
  );
  return rendered.replaceAll(placeholder, localImage);
}

function manifestDocuments(rendered) {
  const documents = [];
  yaml.loadAll(rendered, (document) => {
    if (document) documents.push(document);
  });
  return documents;
}

function findNamed(values, name) {
  const value = values.find((entry) => entry.name === name);
  assert.ok(value, `${name} is absent`);
  return value;
}

function applySecret(fixture, name, type, stringData) {
  fixture.apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: NAMESPACE },
    type,
    stringData,
  });
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

async function terminalJobPod(fixture, name, timeoutMs = 120_000) {
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
      const main = pods[0]?.status.containerStatuses?.[0]?.state?.terminated;
      const init =
        pods[0]?.status.initContainerStatuses?.[0]?.state?.terminated;
      return pods.length === 1 && main && init
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

function configureRetirementResources(rendered, options) {
  const documents = manifestDocuments(
    localManifest(
      rendered,
      'registry.example.com/qinglong/qinglong3-cluster-admin',
      options.adminImage,
      2,
    ),
  );
  const job = documents.find((document) => document.kind === 'Job');
  const networkPolicy = documents.find(
    (document) => document.kind === 'NetworkPolicy',
  );
  assert.ok(job && networkPolicy, 'retirement Job or NetworkPolicy is absent');

  const init = findNamed(
    job.spec.template.spec.initContainers,
    'network-policy-ready',
  );
  findNamed(init.env, 'QL3_NETWORK_POLICY_DENY_CANARY_HOST').value =
    options.denyCanaryHost;
  findNamed(init.env, 'QL3_NETWORK_POLICY_DENY_CANARY_PORT').value = String(
    options.denyCanaryPort,
  );
  networkPolicy.spec.egress.push(
    {
      to: [{ ipBlock: { cidr: `${options.kubernetesServiceIp}/32` } }],
      ports: [{ protocol: 'TCP', port: 443 }],
    },
    {
      to: [{ ipBlock: { cidr: `${options.kubernetesServerIp}/32` } }],
      ports: [{ protocol: 'TCP', port: 6443 }],
    },
  );
  return documents;
}

function denyCanaryResources(adminImage) {
  const labels = {
    'app.kubernetes.io/name': DENY_CANARY,
    'app.kubernetes.io/component': 'live-deny-canary',
  };
  return [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: DENY_CANARY, namespace: NAMESPACE },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            containers: [
              {
                name: 'canary',
                image: adminImage,
                imagePullPolicy: 'Never',
                command: [
                  'node',
                  '-e',
                  "require('node:net').createServer((socket)=>socket.end()).listen(9443,'0.0.0.0')",
                ],
                ports: [{ name: 'canary', containerPort: DENY_CANARY_PORT }],
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
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              seccompProfile: { type: 'RuntimeDefault' },
            },
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: DENY_CANARY, namespace: NAMESPACE },
      spec: {
        selector: labels,
        ports: [
          {
            name: 'canary',
            protocol: 'TCP',
            port: DENY_CANARY_PORT,
            targetPort: 'canary',
          },
        ],
      },
    },
  ];
}

function canaryControlJob(adminImage) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'ql3-retirement-canary-control', namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 30,
      template: {
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          containers: [
            {
              name: 'probe',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '-e',
                "const net=require('node:net');const fs=require('node:fs');const connect=()=>new Promise((resolve)=>{let settled=false;const socket=net.createConnection({host:'ql3-retirement-deny-canary.qinglong3-system.svc',port:9443});const finish=(value)=>{if(settled)return;settled=true;socket.destroy();resolve(value)};socket.setTimeout(500);socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false))});const sleep=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));(async()=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await connect()){fs.writeFileSync('/dev/termination-log','connected');return}await sleep(50)}fs.writeFileSync('/dev/termination-log','failed');process.exitCode=1})().catch(()=>{fs.writeFileSync('/dev/termination-log','failed');process.exitCode=1})",
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
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
        },
      },
    },
  };
}

function canI(fixture, verb, resource, resourceName) {
  const args = [
    'auth',
    'can-i',
    verb,
    resourceName ? `${resource}/${resourceName}` : resource,
    '--as',
    `system:serviceaccount:${NAMESPACE}:${RETIREMENT_SERVICE_ACCOUNT}`,
    '-n',
    NAMESPACE,
  ];
  const result = fixture.kubectl(args, {
    allowFailure: true,
    capture: true,
    quiet: true,
  });
  assert.deepEqual(
    [result.status, result.stdout],
    result.stdout === 'yes' ? [0, 'yes'] : [1, 'no'],
    `unexpected kubectl auth can-i response: status=${String(
      result.status,
    )} stderr=${result.stderr}`,
  );
  return result.stdout;
}

function assertExactRbac(fixture) {
  for (const [verb, resource, name] of [
    ['get', 'secrets', KEYRING_SECRET],
    ['update', 'secrets', KEYRING_SECRET],
  ]) {
    assert.equal(canI(fixture, verb, resource, name), 'yes');
  }
  for (const [verb, resource, name] of [
    ['list', 'secrets'],
    ['watch', 'secrets'],
    ['create', 'secrets'],
    ['delete', 'secrets', KEYRING_SECRET],
    ['patch', 'secrets', KEYRING_SECRET],
    ['get', 'secrets', `${KEYRING_SECRET}-other`],
    ['get', 'configmaps'],
    ['get', 'pods'],
  ]) {
    assert.equal(canI(fixture, verb, resource, name), 'no');
  }
  return true;
}

async function runRetirementJob(fixture, template) {
  fixture.create(template);
  const { pod, terminal } = await terminalJobSnapshot(
    fixture,
    RETIREMENT_JOB,
    5 * 60_000,
  );
  const init = findNamed(
    pod.status.initContainerStatuses,
    'network-policy-ready',
  ).state.terminated;
  const main = findNamed(pod.status.containerStatuses, 'retirement').state
    .terminated;
  assert.equal(terminal.complete, true, main.message);
  assert.equal(terminal.failed, false, main.message);
  assert.equal(init.exitCode, 0, init.message);
  assert.equal(main.exitCode, 0, main.message);
  assert.deepEqual(JSON.parse(init.message), {
    schemaVersion: 1,
    ready: true,
    code: 'POLICY_READY',
  });
  const initSpec = findNamed(pod.spec.initContainers, 'network-policy-ready');
  assert.equal(initSpec.volumeMounts, undefined);
  assert.equal(
    pod.spec.automountServiceAccountToken,
    false,
    'Pod must not receive an automatic token',
  );
  const projected = findNamed(
    pod.spec.volumes,
    'kubernetes-api-token',
  ).projected;
  assert.equal(projected.sources[0].serviceAccountToken.expirationSeconds, 600);
  return Object.freeze({
    tokenAbsentFromInit: initSpec.volumeMounts === undefined,
    denyCanaryEgressDenied: JSON.parse(init.message).code === 'POLICY_READY',
  });
}

async function main() {
  if (process.env.QL3_PROMPT_OUTPUT_KEY_RETIREMENT_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_PROMPT_OUTPUT_KEY_RETIREMENT_KUBERNETES_LIVE=1',
    );
  }
  const operatorManifestFile = process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE;
  if (!operatorManifestFile) {
    throw new Error('QL3_CNPG_OPERATOR_MANIFEST_FILE is required');
  }
  const reviewedManifest = reviewedOperatorManifest(operatorManifestFile);
  const fixture = new K3sDockerLiveFixture({ prefix: 'ql3-key-retire-live' });
  const suffix = `${process.pid.toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const adminImage = `${ADMIN_IMAGE_BASE}:${suffix}`;
  const controlImage = `${CONTROL_IMAGE_BASE}:${suffix}`;
  let adminImageBuilt = false;
  let controlImageBuilt = false;
  let completed = false;
  try {
    const nodes = await fixture.start();
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    assert.ok(['amd64', 'arm64'].includes(architecture));

    for (const [index, reviewedImage] of [
      OPERATOR_IMAGE,
      POSTGRES_IMAGE,
    ].entries()) {
      if (
        fixture.dockerRun(['image', 'inspect', reviewedImage], {
          capture: true,
          quiet: true,
          allowFailure: true,
        }).status !== 0
      ) {
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
      fixture.loadImage(preloadTag, `reviewed-${String(index)}.tar`);
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
    for (const role of ROLE_NAMES) {
      applySecret(fixture, roleSecretName(role), 'kubernetes.io/basic-auth', {
        username: role,
        password: randomSecret(),
      });
    }
    fixture.kubectl([
      'apply',
      '-k',
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg',
    ]);
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
    fixture.loadImage(adminImage, 'key-retirement-admin.tar');
    fixture.loadImage(controlImage, 'key-retirement-migration.tar');

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
    const migrationJobTemplate = manifestDocuments(migrationManifest).find(
      (document) => document.kind === 'Job',
    );
    assert.ok(migrationJobTemplate, 'migration Job template is unavailable');
    fixture.kubectl(['create', '-f', '-'], { input: migrationManifest });
    assert.equal(
      (await waitForJob(fixture, 'ql3-cluster-migration', 10 * 60_000))
        .complete,
      true,
    );
    fixture.create(aiFeatureMigrationJob(migrationJobTemplate, adminImage));
    assert.equal(
      (await waitForJob(fixture, 'ql3-ai-feature-migration', 10 * 60_000))
        .complete,
      true,
    );

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
    assert.equal(databaseFacts.migrationCount, 52);
    assert.equal(databaseFacts.aiMigrationCount, 16);

    for (const resource of denyCanaryResources(adminImage)) {
      fixture.apply(resource);
    }
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'rollout',
      'status',
      `deployment/${DENY_CANARY}`,
      '--timeout=3m',
    ]);
    fixture.create(canaryControlJob(adminImage));
    const controlProbe = await waitForJob(
      fixture,
      'ql3-retirement-canary-control',
      60_000,
    );
    assert.equal(controlProbe.complete, true);
    const controlPod = await waitFor('canary control Pod', 60_000, () => {
      const pods = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        'batch.kubernetes.io/job-name=ql3-retirement-canary-control',
      ]).items;
      const state = pods[0]?.status.containerStatuses?.[0]?.state?.terminated;
      return state
        ? { ready: true, value: pods[0] }
        : { ready: false, fact: `${pods.length} Pods observed` };
    });
    assert.equal(
      controlPod.value.status.containerStatuses[0].state.terminated.message,
      'connected',
    );

    const inactiveKeyId = 'cluster-key-old';
    const activeKeyId = 'cluster-key-active';
    const initialManifest = Object.freeze({
      schema: 'qinglong/plugin-package-prompt-output-file-keyring@v1',
      generation: 1,
      activeKeyId,
      keys: Object.freeze({
        [inactiveKeyId]: randomSecret(),
        [activeKeyId]: randomSecret(),
      }),
      retirements: Object.freeze({}),
    });
    const initialBytes =
      canonicalPluginPackagePromptOutputKeyringManifest(initialManifest);
    fixture.create({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: KEYRING_SECRET,
        namespace: NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'qinglong3',
          'qinglong.io/prompt-output-keyring': 'v1',
        },
        annotations: {
          'qinglong.io/prompt-output-keyring-generation': '1',
          'qinglong.io/prompt-output-keyring-catalog-digest':
            pluginPackagePromptOutputKeyringCatalogDigest(initialManifest),
        },
      },
      type: 'Opaque',
      immutable: false,
      data: { [KEYRING_DATA_KEY]: initialBytes.toString('base64') },
    });
    initialBytes.fill(0);
    const initialSecret = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      KEYRING_SECRET,
    ]);
    const initialResourceVersion = initialSecret.metadata.resourceVersion;
    const secretUid = initialSecret.metadata.uid;
    assert.match(secretUid, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

    fixture.create({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: COMMAND_CONFIG_MAP, namespace: NAMESPACE },
      immutable: true,
      data: {
        'command.json': JSON.stringify({
          schemaVersion: 1,
          operation: 'cluster.prompt-output-key.retire',
          kubernetes: {
            namespace: NAMESPACE,
            secretName: KEYRING_SECRET,
            expectedSecretUid: secretUid,
            dataKey: KEYRING_DATA_KEY,
          },
          request: {
            keyId: inactiveKeyId,
            retirementId: 'retirement-live-1',
            requestId: 'request-live-1',
            mutationId: 'mutation-live-1',
          },
        }),
      },
    });

    const kubernetesServiceIp = fixture.kubectlJson([
      '-n',
      'default',
      'get',
      'service',
      'kubernetes',
    ]).spec.clusterIP;
    const retirementResources = configureRetirementResources(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      {
        adminImage,
        denyCanaryHost: `${DENY_CANARY}.${NAMESPACE}.svc`,
        denyCanaryPort: DENY_CANARY_PORT,
        kubernetesServiceIp,
        kubernetesServerIp: fixture.containerAddress(fixture.server),
      },
    );
    const retirementTemplate = retirementResources.find(
      (resource) => resource.kind === 'Job',
    );
    assert.ok(retirementTemplate);
    for (const resource of retirementResources.filter(
      (candidate) => candidate.kind !== 'Job',
    )) {
      fixture.apply(resource);
    }
    const rbacExact = assertExactRbac(fixture);

    const first = await runRetirementJob(fixture, retirementTemplate);
    const afterFirst = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      KEYRING_SECRET,
    ]);
    assert.equal(afterFirst.metadata.uid, secretUid);
    assert.notEqual(
      afterFirst.metadata.resourceVersion,
      initialResourceVersion,
    );
    let afterFirstBytes = Buffer.from(
      afterFirst.data[KEYRING_DATA_KEY],
      'base64',
    );
    const afterFirstManifest =
      parsePluginPackagePromptOutputKeyringManifest(afterFirstBytes);
    afterFirstBytes.fill(0);
    afterFirstBytes = undefined;
    assert.equal(afterFirstManifest.generation, 2);
    assert.equal(afterFirstManifest.keys[inactiveKeyId], undefined);
    assert.equal(typeof afterFirstManifest.keys[activeKeyId], 'string');
    assert.equal(Object.keys(afterFirstManifest.retirements).length, 1);

    fixture.kubectl(
      ['-n', NAMESPACE, 'delete', `job/${RETIREMENT_JOB}`, '--wait=true'],
      { capture: true, quiet: true },
    );
    const replay = await runRetirementJob(fixture, retirementTemplate);
    const afterReplay = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      KEYRING_SECRET,
    ]);
    assert.equal(
      afterReplay.metadata.resourceVersion,
      afterFirst.metadata.resourceVersion,
    );

    const ledgerFacts = JSON.parse(
      psql(
        fixture,
        currentPrimaryPod(fixture).metadata.name,
        `SELECT json_build_object(
           'preparationCount', (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_prompt_output_key_retirement_preparations" WHERE key_id = '${inactiveKeyId}'),
           'completionCount', (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_prompt_output_key_retirement_completions" WHERE key_id = '${inactiveKeyId}')
         )::text;`,
      ),
    );
    assert.deepEqual(ledgerFacts, {
      preparationCount: 1,
      completionCount: 1,
    });

    const kubernetesImage = fixture.inspectImage(fixture.k3sImage);
    const report = Object.freeze({
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: Object.freeze({
        distribution: 'k3s',
        kubernetesVersion: nodes[0].status.nodeInfo.kubeletVersion,
        architecture,
        kubernetesImageId: kubernetesImage.Id,
        cniName: 'flannel',
        controlPlaneNodes: 1,
        workerNodes: 2,
      }),
      database: Object.freeze({
        operator: 'cloudnative-pg',
        operatorVersion: OPERATOR_VERSION,
        postgresVersionNumber: databaseFacts.postgresVersionNumber,
        instances: 3,
        readyInstances: readyDatabase.length,
        migrationCount: databaseFacts.migrationCount,
        aiMigrationCount: databaseFacts.aiMigrationCount,
        role: 'ql3_ai_maintenance',
        tlsVerified: true,
      }),
      operation: Object.freeze({
        jobsRun: 2,
        status: 'completed',
        replayStatus: 'existing',
        generationAfter: afterFirstManifest.generation,
        retirementCount: Object.keys(afterFirstManifest.retirements).length,
        preparationCount: ledgerFacts.preparationCount,
        completionCount: ledgerFacts.completionCount,
        projectedTokenExpirationSeconds: 600,
        activeKeyRetained:
          typeof afterFirstManifest.keys[activeKeyId] === 'string',
        inactiveKeyRemoved:
          afterFirstManifest.keys[inactiveKeyId] === undefined,
        resourceVersionChangedOnce:
          initialResourceVersion !== afterFirst.metadata.resourceVersion &&
          afterFirst.metadata.resourceVersion ===
            afterReplay.metadata.resourceVersion,
        secretIdentityBound: afterReplay.metadata.uid === secretUid,
        tokenAbsentFromInit:
          first.tokenAbsentFromInit && replay.tokenAbsentFromInit,
        rbacExact,
        denyCanaryControlReachable: true,
        denyCanaryEgressDenied:
          first.denyCanaryEgressDenied && replay.denyCanaryEgressDenied,
      }),
      gates: Object.freeze({
        contentFreeEvidence: true,
        durableReplay: true,
        exactRbac: true,
        passed: true,
        realCloudNativePg: true,
        realKubernetesApi: true,
        resourceVersionCas: true,
        samePodNetworkBarrier: true,
        shortLivedToken: true,
      }),
      limitations: LIMITATIONS,
    });
    const validation =
      validatePromptOutputKeyRetirementKubernetesLiveReport(report);
    assert.deepEqual(validation.findings, []);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    completed = true;
  } finally {
    if (!completed && process.env[PRESERVE_FAILURE_ENV] === '1') {
      process.stderr.write(
        `Preserved failed fixture containers: ${fixture.nodes.join(', ')}\n`,
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
      `QL3 Prompt output key retirement Kubernetes live contract failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  aiFeatureMigrationJob,
  canaryControlJob,
  configureRetirementResources,
  denyCanaryResources,
  terminalJobSnapshot,
};
