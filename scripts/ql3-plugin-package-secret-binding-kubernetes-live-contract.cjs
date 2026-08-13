#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const { createMutualTlsPki } = require('./lib/ql3-live-pki.cjs');
const {
  podReady,
  readyManagementPods,
} = require('./lib/ql3-management-kubernetes-live.cjs');
const {
  createManagementIdentityCeremony,
} = require('./lib/ql3-management-live-identity.cjs');
const {
  validatePluginPackageSecretBindingKubernetesLiveReport,
} = require('./ql3-plugin-package-secret-binding-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const POSTGRES = 'ql3-secret-binding-postgres';
const POSTGRES_IMAGE = 'postgres:18.4-bookworm';
const POSTGRES_DIGEST =
  'sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const DATABASE = 'qinglong';
const MANAGEMENT = 'ql3-plugin-package-management';
const SERVERNAME = MANAGEMENT + '.' + NAMESPACE + '.svc';
const MANAGEMENT_PATH = '/api/v3/plugin-packages/management';
const PROJECT_ID = 'secret-binding-kubernetes-live';
const PACKAGE_NAME = 'secret-binding-live';
const REQUESTER_ID = 'secret-binding-requester';
const REVIEWER_ID = 'secret-binding-reviewer';
const ACTION_REF = 'secret-binding:secret-binding-live:v1';
const APPROVAL_ID = 'secret-binding-live-approval';
const ADMIN_IMAGE_BASE = 'ql3-secret-binding-kubernetes-live';
const ZERO_DIGEST = 'sha256:' + '0'.repeat(64);
const ISSUER = 'https://identity.qinglong.test/';
const AUDIENCE = 'qinglong3-plugin-package-management';
const ROLE_NAMES = Object.freeze([
  'ql3_migration',
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
const identity = createManagementIdentityCeremony({
  issuer: ISSUER,
  audience: AUDIENCE,
  purpose: 'plugin-package-management',
  tokenType: 'ql3-plugin-package-management+jwt',
  subject: REQUESTER_ID,
  jtiPrefix: 'ql3-secret-binding-live',
});

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function sqlString(value) {
  assert.equal(typeof value, 'string');
  return "'" + value.replaceAll("'", "''") + "'";
}

function privateReportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-plugin-package-secret-binding-kubernetes-live-contract ' +
        '--report=/absolute/private-report.json',
    );
  }
  const report = argv[0].slice('--report='.length);
  if (fs.existsSync(report)) throw new Error('refusing to overwrite report');
  const parent = fs.lstatSync(path.dirname(report));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('report parent must be a real directory');
  }
  return report;
}

function writePrivateReport(reportFile, report) {
  const temporary = path.join(
    path.dirname(reportFile),
    '.' + path.basename(reportFile) + '.' + process.pid + '.tmp',
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, reportFile);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function imageId(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return image.Id;
}

function ensurePostgresImage(fixture) {
  let inspected = fixture.dockerRun(['image', 'inspect', POSTGRES_IMAGE], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  if (inspected.status !== 0) {
    run(fixture.docker, ['pull', POSTGRES_IMAGE + '@' + POSTGRES_DIGEST]);
    inspected = fixture.dockerRun(['image', 'inspect', POSTGRES_IMAGE], {
      capture: true,
      quiet: true,
    });
  }
  const image = JSON.parse(inspected.stdout)[0];
  assert.ok(
    image.RepoDigests?.includes('postgres@' + POSTGRES_DIGEST),
    'PostgreSQL image does not retain the reviewed digest',
  );
  fixture.loadImage(POSTGRES_IMAGE, 'secret-binding-postgres.tar');
}

function applySecret(fixture, name, stringData, type = 'Opaque') {
  fixture.apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: NAMESPACE },
    immutable: true,
    type,
    stringData,
  });
}

function postgresResources(superuserPassword) {
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: POSTGRES + '-superuser', namespace: NAMESPACE },
      immutable: true,
      type: 'Opaque',
      stringData: { password: superuserPassword },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: POSTGRES, namespace: NAMESPACE },
      spec: {
        selector: { 'app.kubernetes.io/name': POSTGRES },
        ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: POSTGRES,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/name': POSTGRES },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [
          {
            name: 'postgres',
            image: POSTGRES_IMAGE,
            imagePullPolicy: 'Never',
            env: [
              { name: 'POSTGRES_USER', value: 'postgres' },
              { name: 'POSTGRES_DB', value: 'postgres' },
              {
                name: 'POSTGRES_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: POSTGRES + '-superuser',
                    key: 'password',
                  },
                },
              },
            ],
            ports: [{ name: 'postgres', containerPort: 5432 }],
            readinessProbe: {
              exec: {
                command: [
                  'pg_isready',
                  '--username',
                  'postgres',
                  '--dbname',
                  'postgres',
                ],
              },
              periodSeconds: 2,
              failureThreshold: 60,
            },
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1', memory: '512Mi' },
            },
            volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql' }],
          },
        ],
        volumes: [{ name: 'data', emptyDir: { sizeLimit: '2Gi' } }],
      },
    },
  ];
}

function psql(fixture, database, sql, options = {}) {
  const result = fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      '-i',
      POSTGRES,
      '--',
      ...(options.password ? ['env', 'PGPASSWORD=' + options.password] : []),
      'psql',
      '--username',
      options.user ?? 'postgres',
      '--dbname',
      database,
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
    ],
    {
      input: sql + '\n',
      capture: true,
      quiet: true,
      allowFailure: options.allowFailure === true,
    },
  );
  return result;
}

function createDatabaseRoles(fixture, passwords) {
  const statements = ROLE_NAMES.map(
    (role) =>
      'CREATE ROLE ' +
      role +
      ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ' +
      'NOREPLICATION NOBYPASSRLS PASSWORD ' +
      sqlString(passwords[role]) +
      ';',
  );
  psql(fixture, 'postgres', statements.join('\n'));
  psql(
    fixture,
    'postgres',
    'CREATE DATABASE ' + DATABASE + ' OWNER ql3_migration;',
  );
}

function roleEnvironment(role, passwordKey, applicationName) {
  const prefix = 'QL3_POSTGRES_' + role;
  return [
    { name: 'QL3_POSTGRES_TLS_MODE', value: 'disable' },
    { name: 'QL3_POSTGRES_ALLOW_INSECURE', value: 'true' },
    { name: 'QL3_POSTGRES_APPLICATION_NAME', value: applicationName },
    { name: prefix + '_HOST', value: POSTGRES },
    { name: prefix + '_PORT', value: '5432' },
    { name: prefix + '_DATABASE', value: DATABASE },
    {
      name: prefix + '_USER',
      value: 'ql3_' + role.toLowerCase(),
    },
    {
      name: prefix + '_PASSWORD',
      valueFrom: {
        secretKeyRef: { name: 'ql3-secret-binding-db-auth', key: passwordKey },
      },
    },
  ];
}

function migrationJob(adminImage) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'ql3-secret-binding-migration', namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: { 'app.kubernetes.io/name': 'ql3-secret-binding-migration' },
        },
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
              name: 'migration',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '/opt/qinglong/node_modules/@qinglong/cluster-postgres/' +
                  'dist/migration/migrationCli.js',
              ],
              terminationMessagePolicy: 'FallbackToLogsOnError',
              env: roleEnvironment(
                'MIGRATION',
                'migration-password',
                'ql3-secret-binding-migration',
              ),
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } },
          ],
        },
      },
    },
  };
}

async function waitJob(fixture, name, timeoutMs = 600_000) {
  const result = await waitFor(name + ' completion', timeoutMs, () => {
    const job = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
    const complete = job.status?.conditions?.some(
      (condition) =>
        condition.type === 'Complete' && condition.status === 'True',
    );
    const failed = job.status?.conditions?.some(
      (condition) => condition.type === 'Failed' && condition.status === 'True',
    );
    return complete || failed
      ? { ready: true, value: { complete, failed } }
      : { ready: false, fact: JSON.stringify(job.status ?? {}) };
  });
  if (!result.value.complete) {
    const pods = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'pods',
      '-l',
      'batch.kubernetes.io/job-name=' + name,
    ]).items;
    let logs = fixture.kubectl(
      ['-n', NAMESPACE, 'logs', 'job/' + name, '--all-containers=true'],
      { capture: true, quiet: true, allowFailure: true },
    );
    if (logs.status !== 0 && pods[0]) {
      logs = fixture.kubectl(
        [
          '-n',
          NAMESPACE,
          'logs',
          pods[0].metadata.name,
          '--all-containers=true',
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
    }
    const facts = pods.map((pod) => ({
      name: pod.metadata.name,
      nodeName: pod.spec.nodeName,
      phase: pod.status?.phase,
      reason: pod.status?.reason,
      message: pod.status?.message,
      containers: pod.status?.containerStatuses?.map((status) => ({
        name: status.name,
        state: status.state,
        lastState: status.lastState,
        message: status.state?.terminated?.message,
      })),
    }));
    throw new Error(
      name +
        ' failed: pods=' +
        JSON.stringify(facts) +
        '\nstdout=' +
        logs.stdout +
        '\nstderr=' +
        logs.stderr,
    );
  }
  return result.value;
}

function jobLog(fixture, name) {
  const logs = fixture.kubectl(
    ['-n', NAMESPACE, 'logs', 'job/' + name, '--all-containers=true'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (logs.status === 0) return logs.stdout;
  const pod = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    'batch.kubernetes.io/job-name=' + name,
  ]).items[0];
  const messages = pod?.status?.containerStatuses
    ?.map((status) => status.state?.terminated?.message)
    .filter(Boolean);
  if (!messages?.length) {
    throw new Error(name + ' output is unavailable: ' + logs.stderr);
  }
  return messages.join('\n');
}

function lastJsonLine(output, predicate) {
  const found = output
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .findLast(predicate);
  assert.ok(found, 'expected JSON evidence was absent from output');
  return found;
}

function bootstrapJob(adminImage, bootstrapSource, urls) {
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'ql3-secret-binding-bootstrap', namespace: NAMESPACE },
      data: { 'bootstrap.cjs': bootstrapSource },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-secret-binding-bootstrap-db',
        namespace: NAMESPACE,
      },
      immutable: true,
      type: 'Opaque',
      stringData: urls,
    },
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'ql3-secret-binding-bootstrap', namespace: NAMESPACE },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 600,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'ql3-secret-binding-bootstrap',
            },
          },
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
                name: 'bootstrap',
                image: adminImage,
                imagePullPolicy: 'Never',
                command: ['node', '/opt/ql3-live/bootstrap.cjs'],
                terminationMessagePolicy: 'FallbackToLogsOnError',
                env: [
                  { name: 'NODE_PATH', value: '/opt/qinglong/node_modules' },
                  ...[
                    'QL3_TEST_POSTGRES_MIGRATION_URL',
                    'QL3_TEST_POSTGRES_PACKAGE_MANAGER_URL',
                    'QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL',
                  ].map((name) => ({
                    name,
                    valueFrom: {
                      secretKeyRef: {
                        name: 'ql3-secret-binding-bootstrap-db',
                        key: name,
                      },
                    },
                  })),
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
                    name: 'source',
                    mountPath: '/opt/ql3-live',
                    readOnly: true,
                  },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              {
                name: 'source',
                configMap: {
                  name: 'ql3-secret-binding-bootstrap',
                  defaultMode: 292,
                },
              },
              { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } },
            ],
          },
        },
      },
    },
  ];
}

function yamlDocuments(value) {
  const documents = [];
  yaml.loadAll(value, (document) => {
    if (document) documents.push(document);
  });
  return documents;
}

function envIndex(container) {
  return new Map(container.env.map((entry, index) => [entry.name, index]));
}

function setEnvironment(container, entry) {
  const index = envIndex(container).get(entry.name);
  if (index === undefined) container.env.push(entry);
  else container.env[index] = entry;
}

function renderManagement(fixture, adminImage) {
  const rendered = fixture.kubectl(
    [
      'kustomize',
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/base',
    ],
    { capture: true, quiet: true },
  ).stdout;
  const resources = yamlDocuments(rendered);
  const deployment = resources.find((value) => value.kind === 'Deployment');
  assert.ok(deployment);
  const container = deployment.spec.template.spec.containers[0];
  container.image = adminImage;
  container.imagePullPolicy = 'Never';
  container.env = container.env.filter(
    (entry) =>
      ![
        'QL3_POSTGRES_PACKAGE_MANAGER_URL',
        'QL3_POSTGRES_PACKAGE_MANAGER_TLS_SERVERNAME',
        'QL3_POSTGRES_PACKAGE_MANAGER_TLS_CA_FILE',
      ].includes(entry.name),
  );
  setEnvironment(container, {
    name: 'QL3_POSTGRES_PACKAGE_MANAGER_TLS_MODE',
    value: 'disable',
  });
  setEnvironment(container, {
    name: 'QL3_POSTGRES_PACKAGE_MANAGER_ALLOW_INSECURE',
    value: 'true',
  });
  for (const entry of roleEnvironment(
    'PACKAGE_MANAGER',
    'package-manager-password',
    'ql3-secret-binding-manager',
  )) {
    if (
      !['QL3_POSTGRES_TLS_MODE', 'QL3_POSTGRES_ALLOW_INSECURE'].includes(
        entry.name,
      )
    ) {
      setEnvironment(container, entry);
    }
  }
  container.volumeMounts = container.volumeMounts.filter(
    (entry) => entry.name !== 'postgres-package-manager-ca',
  );
  deployment.spec.template.spec.volumes =
    deployment.spec.template.spec.volumes.filter(
      (entry) => entry.name !== 'postgres-package-manager-ca',
    );
  const networkPolicy = resources.find(
    (value) => value.kind === 'NetworkPolicy',
  );
  networkPolicy.spec.egress.push({
    to: [
      { podSelector: { matchLabels: { 'app.kubernetes.io/name': POSTGRES } } },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  });
  return resources;
}

function managementConfiguration(fixture, pki, identityKey) {
  const publisher = crypto.generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  applySecret(
    fixture,
    MANAGEMENT + '-tls',
    {
      'tls.crt': pki.serverCertificate,
      'tls.key': pki.serverKey,
    },
    'kubernetes.io/tls',
  );
  applySecret(fixture, MANAGEMENT + '-identity', {
    'keyset.json': JSON.stringify(identity.keyset(1, [identityKey])) + '\n',
  });
  fixture.apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'ql3-plugin-publisher-trust', namespace: NAMESPACE },
    data: {
      'publishers.json':
        JSON.stringify({
          schema: 'qinglong/plugin-package-publisher-trust@v1',
          keys: [
            {
              publisher: 'live.qinglong.test',
              keyId: 'live-key-1',
              publicKeyPem: publisher,
              notBeforeMs: Date.now() - 60_000,
              notAfterMs: Date.now() + 86_400_000,
            },
          ],
        }) + '\n',
    },
  });
}

async function executeClient(fixture, options) {
  const inputName = options.name + '-input';
  const config = {
    schemaVersion: 1,
    endpoint: 'https://' + SERVERNAME + ':8443' + MANAGEMENT_PATH,
    servername: SERVERNAME,
    caFile: '/tmp/ca.crt',
    requestTimeoutMs: 5_000,
  };
  applySecret(fixture, inputName, {
    'client.json': JSON.stringify(config) + '\n',
    'command.json': JSON.stringify(options.command) + '\n',
    'assertion.jwt': options.bearer,
    'ca.crt': options.ca,
  });
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: options.name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 240,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-secret-binding-client',
            'qinglong.io/plugin-package-management-client': 'true',
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          hostAliases: [
            { ip: options.target.status.podIP, hostnames: [SERVERNAME] },
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
              image: options.adminImage,
              imagePullPolicy: 'Never',
              command: ['/bin/sh', '-c'],
              args: [
                [
                  'set -eu',
                  'umask 077',
                  'cp /var/run/ql3/client/client.json /tmp/client.json',
                  'cp /var/run/ql3/client/command.json /tmp/command.json',
                  'cp /var/run/ql3/client/assertion.jwt /tmp/assertion.jwt',
                  'cp /var/run/ql3/client/ca.crt /tmp/ca.crt',
                  'chmod 600 /tmp/client.json /tmp/command.json /tmp/assertion.jwt /tmp/ca.crt',
                  'attempt=0',
                  'while true; do',
                  '  attempt=$((attempt + 1))',
                  '  set +e',
                  '  output="$(node /opt/qinglong/node_modules/@qinglong/cluster-admin/' +
                    'dist/plugin-package/management/pluginPackageManagementClientCli.js ' +
                    '--config=/tmp/client.json --command=/tmp/command.json ' +
                    '--assertion=/tmp/assertion.jwt 2>&1)"',
                  '  status=$?',
                  '  set -e',
                  '  if [ "$status" -eq 0 ] || [ "$attempt" -ge 60 ]; then break; fi',
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
                  mountPath: '/var/run/ql3/client',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '4Mi' } },
            {
              name: 'input',
              secret: { secretName: inputName, defaultMode: 288 },
            },
          ],
        },
      },
    },
  });
  await waitJob(fixture, options.name, 300_000);
  const pod = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    'batch.kubernetes.io/job-name=' + options.name,
  ]).items[0];
  assert.ok(pod);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  const terminated = pod.status.containerStatuses[0].state.terminated;
  assert.ok(terminated);
  assert.equal(terminated.message.includes(options.bearer), false);
  const output = lastJsonLine(
    terminated.message,
    (value) => value.event === 'command_completed',
  );
  assert.equal(output.result.operation, options.command.operation);
  return Object.freeze({ output, pod });
}

function baseCommand(operation, request) {
  return Object.freeze({ schemaVersion: 1, operation, request });
}

function canI(fixture, serviceAccount, verb) {
  const result = fixture.kubectl(
    [
      'auth',
      'can-i',
      verb,
      'secrets',
      '--namespace',
      NAMESPACE,
      '--as',
      'system:serviceaccount:' + NAMESPACE + ':' + serviceAccount,
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  assert.ok(result.stdout === 'yes' || result.stdout === 'no');
  return result.stdout === 'yes';
}

function renderExecutor(fixture, adminImage) {
  const rendered = fixture.kubectl(
    [
      'kustomize',
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-executor/base',
    ],
    { capture: true, quiet: true },
  ).stdout;
  const resources = yamlDocuments(rendered);
  const cronJob = resources.find((value) => value.kind === 'CronJob');
  assert.ok(cronJob);
  cronJob.spec.suspend = true;
  cronJob.spec.jobTemplate.spec.backoffLimit = 0;
  const template = cronJob.spec.jobTemplate.spec.template.spec;
  const container = template.containers[0];
  container.image = adminImage;
  container.imagePullPolicy = 'Never';
  const executorCommand = container.command;
  assert.deepEqual(executorCommand.slice(0, 1), ['node']);
  container.command = ['/bin/sh', '-c'];
  container.args = [
    [
      'set +e',
      'output="$(' + executorCommand.join(' ') + ' 2>&1)"',
      'status=$?',
      'printf \'%s\\n\' "$output" > /dev/termination-log',
      'printf \'%s\\n\' "$output"',
      'exit "$status"',
    ].join('\n'),
  ];
  container.terminationMessagePolicy = 'File';
  container.env = container.env.filter(
    (entry) =>
      ![
        'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
        'QL3_POSTGRES_TLS_SERVERNAME',
        'QL3_POSTGRES_TLS_CA_FILE',
      ].includes(entry.name),
  );
  setEnvironment(container, {
    name: 'QL3_POSTGRES_TLS_MODE',
    value: 'disable',
  });
  setEnvironment(container, {
    name: 'QL3_POSTGRES_ALLOW_INSECURE',
    value: 'true',
  });
  for (const entry of roleEnvironment(
    'PACKAGE_EXECUTOR',
    'package-executor-password',
    'ql3-secret-binding-executor',
  )) {
    if (
      !['QL3_POSTGRES_TLS_MODE', 'QL3_POSTGRES_ALLOW_INSECURE'].includes(
        entry.name,
      )
    ) {
      setEnvironment(container, entry);
    }
  }
  container.volumeMounts = container.volumeMounts.filter(
    (entry) => entry.name !== 'postgres-package-executor-ca',
  );
  template.volumes = template.volumes.filter(
    (entry) => entry.name !== 'postgres-package-executor-ca',
  );
  const networkPolicy = resources.find(
    (value) => value.kind === 'NetworkPolicy',
  );
  networkPolicy.spec.egress.push({
    to: [
      { podSelector: { matchLabels: { 'app.kubernetes.io/name': POSTGRES } } },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  });
  return resources;
}

function persistenceEvidence(fixture, sensitiveValue) {
  const sql = `
SELECT json_build_object(
  'bindingCount', (SELECT count(*)::integer
    FROM ql3.plugin_package_secret_bindings
    WHERE project_id = ${sqlString(PROJECT_ID)}
      AND package_name = ${sqlString(PACKAGE_NAME)}),
  'authorityKind', (SELECT authority_kind
    FROM ql3.plugin_package_secret_bindings
    WHERE project_id = ${sqlString(PROJECT_ID)}
      AND package_name = ${sqlString(PACKAGE_NAME)}),
  'evidenceDigest', (SELECT evidence_digest
    FROM ql3.plugin_package_secret_bindings
    WHERE project_id = ${sqlString(PROJECT_ID)}
      AND package_name = ${sqlString(PACKAGE_NAME)}),
  'entryCount', (SELECT jsonb_array_length(binding_json -> 'entries')
    FROM ql3.plugin_package_secret_bindings
    WHERE project_id = ${sqlString(PROJECT_ID)}
      AND package_name = ${sqlString(PACKAGE_NAME)}),
  'approvalConsumed', (SELECT state = 'consumed'
    FROM ql3.approval_requests WHERE request_id = ${sqlString(APPROVAL_ID)}),
  'executionSucceeded', (SELECT execution.status = 'succeeded'
    FROM ql3.approval_requests AS approval
    JOIN ql3.approved_action_executions AS execution
      ON execution.dispatch_id = approval.dispatch_id
    WHERE approval.request_id = ${sqlString(APPROVAL_ID)}),
  'sensitiveMatchCount', (SELECT count(*)::integer FROM (
    SELECT binding_json::text AS payload FROM ql3.plugin_package_secret_bindings
    UNION ALL SELECT plan_json::text FROM ql3.plugin_package_secret_binding_approval_plans
    UNION ALL SELECT request_json::text FROM ql3.approval_requests
    UNION ALL SELECT execution_json::text FROM ql3.approved_action_executions
  ) AS durable WHERE strpos(payload, ${sqlString(sensitiveValue)}) > 0)
)::text;
  `.trim();
  return JSON.parse(psql(fixture, DATABASE, sql).stdout);
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  if (process.env.QL3_PLUGIN_PACKAGE_SECRET_BINDING_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_PLUGIN_PACKAGE_SECRET_BINDING_KUBERNETES_LIVE=1',
    );
  }
  const fixture = new K3sDockerLiveFixture({
    prefix: 'ql3-secret-binding-live',
  });
  const suffix =
    process.pid.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const adminImage = ADMIN_IMAGE_BASE + ':' + suffix;
  let adminImageBuilt = false;
  try {
    const nodes = await fixture.start();
    assert.equal(nodes.length, 3);
    ensurePostgresImage(fixture);
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
      'SOURCE_REVISION=' + sourceRevision,
      '.',
    ]);
    adminImageBuilt = true;
    fixture.loadImage(adminImage, 'secret-binding-admin.tar');
    const adminImageInfo = fixture.inspectImage(adminImage);
    assert.ok(['amd64', 'arm64'].includes(adminImageInfo.Architecture));

    fixture.apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NAMESPACE },
    });
    const superuserPassword = randomSecret();
    for (const resource of postgresResources(superuserPassword)) {
      fixture.apply(resource);
    }
    await waitFor('PostgreSQL readiness', 300_000, () => {
      const pod = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pod',
        POSTGRES,
      ]);
      return podReady(pod)
        ? { ready: true, value: pod }
        : { ready: false, fact: pod.status?.phase ?? 'unknown' };
    });
    const passwords = Object.fromEntries(
      ROLE_NAMES.map((role) => [role, randomSecret()]),
    );
    createDatabaseRoles(fixture, passwords);
    applySecret(fixture, 'ql3-secret-binding-db-auth', {
      'migration-password': passwords.ql3_migration,
      'package-manager-password': passwords.ql3_package_manager,
      'package-executor-password': passwords.ql3_package_executor,
    });
    fixture.create(migrationJob(adminImage));
    await waitJob(fixture, 'ql3-secret-binding-migration');
    const postgresVersionNumber = Number(
      psql(fixture, DATABASE, 'SHOW server_version_num;').stdout,
    );
    assert.equal(postgresVersionNumber, 180004);

    const databaseUrl = (role) =>
      'postgresql://' +
      role +
      ':' +
      passwords[role] +
      '@' +
      POSTGRES +
      ':5432/' +
      DATABASE;
    const bootstrapResources = bootstrapJob(
      adminImage,
      fs.readFileSync(
        path.join(
          ROOT,
          'scripts/ql3-plugin-package-secret-binding-kubernetes-live-bootstrap.cjs',
        ),
        'utf8',
      ),
      {
        QL3_TEST_POSTGRES_MIGRATION_URL: databaseUrl('ql3_migration'),
        QL3_TEST_POSTGRES_PACKAGE_MANAGER_URL: databaseUrl(
          'ql3_package_manager',
        ),
        QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL: databaseUrl(
          'ql3_package_executor',
        ),
      },
    );
    for (const resource of bootstrapResources) fixture.create(resource);
    await waitJob(fixture, 'ql3-secret-binding-bootstrap');
    const prerequisite = lastJsonLine(
      jobLog(fixture, 'ql3-secret-binding-bootstrap'),
      (value) => value.event === 'secret_binding_prerequisite_ready',
    );
    assert.equal(prerequisite.projectId, PROJECT_ID);
    assert.equal(prerequisite.packageName, PACKAGE_NAME);
    assert.match(prerequisite.secretRef, /^qlsecret:v1:/);
    assert.match(prerequisite.projectionKey, /^[a-f0-9]{64}$/);

    const pki = createMutualTlsPki({
      directory: fixture.temporary,
      servername: SERVERNAME,
      label: 'QL3 Secret Binding Live',
      run,
      crypto,
    }).read();
    const identityKey = identity.reviewedKey('secret-binding-live-key-1');
    managementConfiguration(fixture, pki, identityKey);
    for (const resource of renderManagement(fixture, adminImage)) {
      fixture.apply(resource);
    }
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'rollout',
      'status',
      'deployment/' + MANAGEMENT,
      '--timeout=5m',
    ]);
    const managementPods = await readyManagementPods({
      fixture,
      namespace: NAMESPACE,
      deployment: MANAGEMENT,
      description: 'two Secret binding management replicas',
    });
    assert.equal(managementPods.length, 2);
    const managementDeployment = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'deployment',
      MANAGEMENT,
    ]);
    const managementTemplate = managementDeployment.spec.template.spec;
    const managementMounts = managementTemplate.containers[0].volumeMounts;
    assert.equal(managementTemplate.automountServiceAccountToken, false);
    assert.equal(
      managementMounts.some((entry) => entry.name === 'plugin-package-values'),
      false,
    );
    assert.equal(canI(fixture, MANAGEMENT, 'get'), false);
    assert.equal(canI(fixture, MANAGEMENT, 'list'), false);

    const requester = () =>
      identity.assertionForSubject(identityKey, REQUESTER_ID);
    const reviewer = () =>
      identity.assertionForSubject(identityKey, REVIEWER_ID);
    const planCommand = baseCommand('plugin-package.secret-binding.plan', {
      actionRef: ACTION_REF,
      projectId: PROJECT_ID,
      packageName: PACKAGE_NAME,
      assignments: [{ name: 'TOKEN', secretRef: prerequisite.secretRef }],
    });
    const planned = await executeClient(fixture, {
      name: 'ql3-secret-binding-plan-a',
      target: managementPods[0],
      command: planCommand,
      bearer: requester(),
      ca: pki.ca,
      adminImage,
    });
    assert.equal(planned.output.result.status, 'created');
    const replayed = await executeClient(fixture, {
      name: 'ql3-secret-binding-plan-b',
      target: managementPods[1],
      command: planCommand,
      bearer: requester(),
      ca: pki.ca,
      adminImage,
    });
    assert.equal(replayed.output.result.status, 'existing');
    const proposed = await executeClient(fixture, {
      name: 'ql3-secret-binding-propose-a',
      target: managementPods[0],
      command: baseCommand('plugin-package.secret-binding.propose', {
        actionRef: ACTION_REF,
        approvalRequestId: APPROVAL_ID,
        approvalAuditEventId: crypto.randomUUID(),
      }),
      bearer: requester(),
      ca: pki.ca,
      adminImage,
    });
    assert.equal(proposed.output.result.approvalStatus, 'created');
    const decided = await executeClient(fixture, {
      name: 'ql3-secret-binding-decide-b',
      target: managementPods[1],
      command: baseCommand('plugin-package.secret-binding.decide', {
        actionRef: ACTION_REF,
        approvalRequestId: APPROVAL_ID,
        expectedVersion: proposed.output.result.approval.version,
        decisionId: 'secret-binding-live-decision',
        auditEventId: crypto.randomUUID(),
        decision: 'approved',
        reasonCode: 'reviewed',
      }),
      bearer: reviewer(),
      ca: pki.ca,
      adminImage,
    });
    assert.equal(decided.output.result.status, 'decided');
    const inspected = await executeClient(fixture, {
      name: 'ql3-secret-binding-inspect-a',
      target: managementPods[0],
      command: baseCommand('plugin-package.secret-binding.inspect', {
        actionRef: ACTION_REF,
        approvalRequestId: APPROVAL_ID,
        inspectionId: 'secret-binding-live-inspection',
      }),
      bearer: requester(),
      ca: pki.ca,
      adminImage,
    });
    assert.equal(inspected.output.result.stale, false);

    const sensitiveValue = 'ql3-live-' + randomSecret();
    applySecret(fixture, 'ql3-cluster-plugin-package-values', {
      [prerequisite.projectionKey]: sensitiveValue,
    });
    const executorResources = renderExecutor(fixture, adminImage);
    for (const resource of executorResources) fixture.apply(resource);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'create',
      'job',
      'ql3-secret-binding-executor',
      '--from=cronjob/ql3-plugin-package-executor',
    ]);
    await waitJob(fixture, 'ql3-secret-binding-executor');
    const executorOutput = jobLog(fixture, 'ql3-secret-binding-executor');
    assert.equal(executorOutput.includes(sensitiveValue), false);
    assert.equal(executorOutput.includes(prerequisite.secretRef), false);
    const executorPod = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'pods',
      '-l',
      'batch.kubernetes.io/job-name=ql3-secret-binding-executor',
    ]).items[0];
    assert.ok(executorPod);
    assert.equal(executorPod.spec.automountServiceAccountToken, false);
    const executorContainer = executorPod.spec.containers[0];
    const projectionMount = executorContainer.volumeMounts.find(
      (entry) => entry.name === 'plugin-package-values',
    );
    assert.equal(projectionMount.readOnly, true);
    const projectionVolume = executorPod.spec.volumes.find(
      (entry) => entry.name === 'plugin-package-values',
    );
    assert.equal(
      projectionVolume.secret.secretName,
      'ql3-cluster-plugin-package-values',
    );
    assert.equal(canI(fixture, 'ql3-plugin-package-executor', 'get'), false);
    assert.equal(canI(fixture, 'ql3-plugin-package-executor', 'list'), false);
    const persistence = persistenceEvidence(fixture, sensitiveValue);
    assert.deepEqual(persistence, {
      bindingCount: 1,
      authorityKind: 'approved-action-execution',
      evidenceDigest: planned.output.result.plan.approvalPlanDigest,
      entryCount: 1,
      approvalConsumed: true,
      executionSucceeded: true,
      sensitiveMatchCount: 0,
    });
    const managerBindingRead = psql(
      fixture,
      DATABASE,
      'SELECT count(*) FROM ql3.plugin_package_secret_bindings;',
      {
        user: 'ql3_package_manager',
        password: passwords.ql3_package_manager,
        allowFailure: true,
      },
    );
    assert.notEqual(managerBindingRead.status, 0);

    const report = {
      schemaVersion: 1,
      fixture: 'qinglong/plugin-package-secret-binding-kubernetes-live@v1',
      observedAtMs: Date.now(),
      platform: {
        architecture: adminImageInfo.Architecture,
        kubernetesVersion: fixture.kubectlJson(['version']).serverVersion
          .gitVersion,
        nodeCount: nodes.length,
        postgresVersionNumber,
        adminImageId: imageId(adminImageInfo),
      },
      management: {
        replicas: managementPods.length,
        distinctNodeHashes: managementPods
          .map((pod) => sha256(pod.spec.nodeName))
          .sort(),
        serviceAccountTokenMounted: false,
        packageValueVolumeMounted: false,
        canGetSecrets: false,
        canListSecrets: false,
      },
      review: {
        commands: [
          'plugin-package.secret-binding.plan',
          'plugin-package.secret-binding.plan',
          'plugin-package.secret-binding.propose',
          'plugin-package.secret-binding.decide',
          'plugin-package.secret-binding.inspect',
        ],
        requesterSubjectHash: sha256(REQUESTER_ID),
        reviewerSubjectHash: sha256(REVIEWER_ID),
        distinctUsers: REQUESTER_ID !== REVIEWER_ID,
        planStatus: planned.output.result.status,
        replayStatus: replayed.output.result.status,
        decisionStatus: decided.output.result.status,
        inspectionStale: inspected.output.result.stale,
        actionDigest: proposed.output.result.approval.actionDigest,
        planDigest: planned.output.result.plan.planDigest,
      },
      executor: {
        jobSucceeded: true,
        serviceAccountTokenMounted: false,
        canGetSecrets: false,
        canListSecrets: false,
        projectionReadOnly: projectionMount.readOnly,
        projectionFileCount: Object.keys(
          fixture.kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'secret',
            'ql3-cluster-plugin-package-values',
          ]).data,
        ).length,
        projectionKeyHash: sha256(prerequisite.projectionKey),
        outputSensitiveFree:
          !executorOutput.includes(sensitiveValue) &&
          !executorOutput.includes(prerequisite.secretRef),
      },
      persistence,
      gates: {
        realThreeNodeKubernetes: true,
        twoManagementReplicasOnDistinctNodes: true,
        formalHttpsClientCommands: true,
        planReplayedAcrossReplicas: true,
        separationOfDutyDecision: true,
        authorizedInspection: true,
        realExecutorJob: true,
        projectedSecretMetadataAccepted: true,
        bindingPublishedExactlyOnce: true,
        managementCannotReadSecrets: true,
        managementDoesNotMountPackageValues: true,
        executorCannotReadSecrets: true,
        executorHasNoServiceAccountToken: true,
        executorProjectionReadOnly: true,
        databaseContainsNoSensitiveValue: true,
        passed: true,
      },
      limitations: [
        'single-server k3s control plane is not Kubernetes control-plane HA evidence',
        'PostgreSQL physical failover is proven by the independent 125-gate HA contract',
      ],
    };
    const audit =
      validatePluginPackageSecretBindingKubernetesLiveReport(report);
    assert.deepEqual(audit.findings, []);
    writePrivateReport(reportFile, report);
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        event: 'plugin_package_secret_binding_kubernetes_live_completed',
        reportSha256: sha256(fs.readFileSync(reportFile)).slice(
          'sha256:'.length,
        ),
        gates: Object.keys(report.gates).length,
      }) + '\n',
    );
  } finally {
    await fixture.cleanup();
    if (adminImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
      });
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    'QL3 Secret binding Kubernetes live contract failed: ' +
      (error instanceof Error ? error.stack || error.message : String(error)) +
      '\n',
  );
  process.exitCode = 1;
});
