#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const {
  REGISTRY_EVENT_SCHEMA,
  createFixture,
} = require('./ql3-plugin-package-recovery-e2e-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_SCRIPT = path.join(
  __dirname,
  'ql3-plugin-package-recovery-e2e-fixture.cjs',
);
const NAMESPACE = 'ql3-plugin-recovery-e2e';
const CONTROL_SERVICE_ACCOUNT = 'ql3-cluster-control';
const RECOVERY_SERVICE_ACCOUNT = 'ql3-plugin-package-recovery';
const POSTGRES_NAME = 'ql3-postgres-live';
const REGISTRY_NAME = 'ql3-registry-live';
const REGISTRY_HOST = `${REGISTRY_NAME}.${NAMESPACE}.svc`;
const KIND_NODE_IMAGE =
  'kindest/node:v1.32.8@sha256:abd489f042d2b644e2d033f5c2d900bc707798d075e8186cb65e3f1367a9d5a1';
const POSTGRES_IMAGE = 'postgres:18.4-bookworm';
const POSTGRES_INDEX_DIGEST =
  'sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const POSTGRES_IMAGE_REFERENCE = `${POSTGRES_IMAGE}@${POSTGRES_INDEX_DIGEST}`;
const POSTGRES_REPOSITORY_DIGEST = `postgres@${POSTGRES_INDEX_DIGEST}`;
const POSTGRES_RUNTIME_IMAGE =
  'postgres:18.4-bookworm-ql3-plugin-recovery-e2e';
const DEFAULT_ADMIN_IMAGE = 'qinglong3-cluster-admin:ql3-plugin-recovery-e2e';
const DEFAULT_CONTROL_IMAGE =
  'qinglong3-cluster-control:ql3-plugin-recovery-e2e';
const REPORT_SCHEMA = 'qinglong/plugin-package-recovery-e2e-live-contract@v2';
const INITIAL_SEED_JOB = 'ql3-plugin-package-e2e-seed-initial';
const INITIAL_RECOVERY_JOB = 'ql3-plugin-package-recovery-initial';
const UPGRADE_SEED_JOB = 'ql3-plugin-package-e2e-seed-upgrade';
const UPGRADE_STAGE_JOB = 'ql3-plugin-package-recovery-stage-upgrade';
const TRANSITION_JOB = 'ql3-plugin-package-e2e-transition';
const UPGRADE_REJECTION_JOB = 'ql3-plugin-package-recovery-reject-upgrade';
const SAFE_CLUSTER =
  /^ql3-plugin-recovery-e2e(?:-[a-z0-9](?:[-a-z0-9]{0,24}[a-z0-9])?)?$/;

const KIND = process.env.QL3_KIND_BIN || 'kind';
const KUBECTL = process.env.QL3_KUBECTL_BIN || 'kubectl';
const DOCKER = process.env.QL3_DOCKER_BIN || 'docker';
const OPENSSL = process.env.QL3_OPENSSL_BIN || 'openssl';
const ADMIN_IMAGE = process.env.QL3_ADMIN_IMAGE || DEFAULT_ADMIN_IMAGE;
const CONTROL_IMAGE = process.env.QL3_CONTROL_IMAGE || DEFAULT_CONTROL_IMAGE;

function fail(message) {
  throw new Error(message);
}

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

function kind(args, options = {}) {
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

function apply(value, label) {
  kubectl(['apply', '-f', '-'], {
    input: `${JSON.stringify(value)}\n`,
    label,
  });
}

function exactClusterName() {
  const value =
    process.env.QL3_KIND_CLUSTER ??
    `ql3-plugin-recovery-e2e-${process.pid.toString(36)}`;
  if (!SAFE_CLUSTER.test(value)) {
    fail(
      'QL3_KIND_CLUSTER must be an exact ql3-plugin-recovery-e2e[-suffix] name',
    );
  }
  return value;
}

function kindCreateEnvironment(clusterName) {
  const required = [
    '127.0.0.1',
    'localhost',
    `${clusterName}-control-plane`,
    `${clusterName}-worker`,
    `${clusterName}-worker2`,
    '.svc',
    '.cluster.local',
    '10.96.0.0/12',
    '10.244.0.0/16',
    '172.16.0.0/12',
  ];
  const values = [process.env.NO_PROXY, process.env.no_proxy, ...required]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const noProxy = [...new Set(values)].join(',');
  return { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy };
}

function randomSecret() {
  return randomBytes(24).toString('base64url');
}

function architecture() {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  fail(`unsupported live-gate architecture ${process.arch}`);
}

function readYamlDocuments(filePath) {
  const documents = [];
  yaml.loadAll(fs.readFileSync(filePath, 'utf8'), (value) => {
    if (value) documents.push(value);
  });
  return documents;
}

function imageExists(image) {
  return (
    run(DOCKER, ['image', 'inspect', image], {
      capture: true,
      quiet: true,
      allowFailure: true,
    }).status === 0
  );
}

function sourceRevision() {
  const value = process.env.QL3_SOURCE_REVISION ?? '';
  if (!/^[a-f0-9]{40}$/.test(value)) {
    fail(
      'QL3_SOURCE_REVISION must be the exact lowercase 40-hex source revision',
    );
  }
  return value;
}

function privateReportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    fail(
      'usage: ql3-plugin-package-recovery-e2e-live-contract ' +
        '--report=/absolute/private-report.json',
    );
  }
  const reportFile = argv[0].slice('--report='.length);
  if (path.resolve(reportFile) !== reportFile) {
    fail('Plugin Package recovery E2E report path must be canonical');
  }
  if (fs.existsSync(reportFile)) {
    fail('refusing to overwrite the Plugin Package recovery E2E report');
  }
  const parent = fs.lstatSync(path.dirname(reportFile));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    fail('Plugin Package recovery E2E report parent must be a real directory');
  }
  return reportFile;
}

function writePrivateReport(reportFile, report) {
  const temporaryReport = path.join(
    path.dirname(reportFile),
    `.${path.basename(reportFile)}.${process.pid}.` +
      `${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryReport, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryReport, reportFile);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryReport, { force: true });
  }
}

function buildImages(revision) {
  if (process.env.QL3_SKIP_IMAGE_BUILD === '1') {
    assert.equal(imageExists(ADMIN_IMAGE), true, `${ADMIN_IMAGE} is absent`);
    assert.equal(
      imageExists(CONTROL_IMAGE),
      true,
      `${CONTROL_IMAGE} is absent`,
    );
    return;
  }
  run(
    DOCKER,
    [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag',
      ADMIN_IMAGE,
      '--build-arg',
      `SOURCE_REVISION=${revision}`,
      '.',
    ],
    { label: 'build current QingLong 3.0 cluster-admin image' },
  );
  run(
    DOCKER,
    [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-control/Dockerfile',
      '--tag',
      CONTROL_IMAGE,
      '--build-arg',
      `SOURCE_REVISION=${revision}`,
      '.',
    ],
    { label: 'build current QingLong 3.0 cluster-control image' },
  );
}

function ensurePostgresImage() {
  if (!imageExists(POSTGRES_IMAGE_REFERENCE)) {
    run(DOCKER, ['pull', POSTGRES_IMAGE_REFERENCE], {
      label: 'pull digest-pinned PostgreSQL 18.4 fixture image',
    });
  }
  const inspection = JSON.parse(
    run(DOCKER, ['image', 'inspect', POSTGRES_IMAGE_REFERENCE], {
      capture: true,
      quiet: true,
    }).stdout,
  )[0];
  assert.ok(
    inspection.RepoDigests.includes(POSTGRES_REPOSITORY_DIGEST),
    `${POSTGRES_IMAGE} does not match ${POSTGRES_REPOSITORY_DIGEST}`,
  );
  run(DOCKER, ['image', 'tag', POSTGRES_IMAGE_REFERENCE, POSTGRES_RUNTIME_IMAGE], {
    label: 'bind verified PostgreSQL fixture digest to its Kind-local tag',
  });
  assert.equal(imageId(POSTGRES_RUNTIME_IMAGE), inspection.Id);
}

function imageId(image) {
  return JSON.parse(
    run(DOCKER, ['image', 'inspect', image], {
      capture: true,
      quiet: true,
    }).stdout,
  )[0].Id;
}

function imageSourceRevision(image) {
  return JSON.parse(
    run(DOCKER, ['image', 'inspect', image], {
      capture: true,
      quiet: true,
    }).stdout,
  )[0].Config?.Labels?.['org.opencontainers.image.revision'];
}

function createRegistryCertificate(root) {
  const caKey = path.join(root, 'registry-ca.key');
  const caCert = path.join(root, 'registry-ca.crt');
  const serverKey = path.join(root, 'registry-tls.key');
  const request = path.join(root, 'registry.csr');
  const serverCert = path.join(root, 'registry-tls.crt');
  const extensions = path.join(root, 'registry.ext');
  fs.writeFileSync(
    extensions,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${REGISTRY_NAME},DNS:${REGISTRY_HOST},DNS:${REGISTRY_HOST}.cluster.local`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  run(
    OPENSSL,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=QingLong Plugin Recovery E2E Registry CA',
      '-keyout',
      caKey,
      '-out',
      caCert,
    ],
    { quiet: true, capture: true },
  );
  run(
    OPENSSL,
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-subj',
      `/CN=${REGISTRY_HOST}`,
      '-keyout',
      serverKey,
      '-out',
      request,
    ],
    { quiet: true, capture: true },
  );
  run(
    OPENSSL,
    [
      'x509',
      '-req',
      '-sha256',
      '-days',
      '2',
      '-in',
      request,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-extfile',
      extensions,
      '-out',
      serverCert,
    ],
    { quiet: true, capture: true },
  );
  return Object.freeze({
    ca: fs.readFileSync(caCert, 'utf8'),
    cert: fs.readFileSync(serverCert, 'utf8'),
    key: fs.readFileSync(serverKey, 'utf8'),
  });
}

function commonSecurityContext() {
  return {
    runAsNonRoot: true,
    runAsUser: 10001,
    runAsGroup: 10001,
    fsGroup: 10001,
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

function containerSecurityContext() {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
}

function postgresResources(secrets) {
  const initScript = `#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \\
  --set=migration_password="$QL3_MIGRATION_PASSWORD" \\
  --set=runtime_password="$QL3_RUNTIME_PASSWORD" \\
  --set=admin_password="$QL3_ADMIN_PASSWORD" \\
  --set=automation_manager_password="$QL3_AUTOMATION_MANAGER_PASSWORD" \\
  --set=approval_manager_password="$QL3_APPROVAL_MANAGER_PASSWORD" \\
  --set=run_manager_password="$QL3_RUN_MANAGER_PASSWORD" \\
  --set=package_manager_password="$QL3_PACKAGE_MANAGER_PASSWORD" \\
  --set=package_executor_password="$QL3_PACKAGE_EXECUTOR_PASSWORD" \\
  --set=worker_credential_manager_password="$QL3_WORKER_CREDENTIAL_MANAGER_PASSWORD" \\
  --set=worker_credential_executor_password="$QL3_WORKER_CREDENTIAL_EXECUTOR_PASSWORD" \\
  --set=worker_password="$QL3_WORKER_INGRESS_PASSWORD" <<'SQL'
CREATE ROLE ql3_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migration_password';
CREATE ROLE ql3_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
CREATE ROLE ql3_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'admin_password';
CREATE ROLE ql3_automation_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'automation_manager_password';
CREATE ROLE ql3_approval_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'approval_manager_password';
CREATE ROLE ql3_run_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'run_manager_password';
CREATE ROLE ql3_package_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'package_manager_password';
CREATE ROLE ql3_package_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'package_executor_password';
CREATE ROLE ql3_worker_credential_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'worker_credential_manager_password';
CREATE ROLE ql3_worker_credential_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'worker_credential_executor_password';
CREATE ROLE ql3_worker_ingress LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'worker_password';
SQL
createdb --username "$POSTGRES_USER" --owner ql3_migration qinglong
`;
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-e2e-postgres-auth', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'postgres-password': secrets.postgres,
        'migration-password': secrets.migration,
        'runtime-password': secrets.runtime,
        'admin-password': secrets.admin,
        'automation-manager-password': secrets.automationManager,
        'approval-manager-password': secrets.approvalManager,
        'run-manager-password': secrets.runManager,
        'package-manager-password': secrets.packageManager,
        'package-executor-password': secrets.packageExecutor,
        'worker-credential-manager-password': secrets.workerCredentialManager,
        'worker-credential-executor-password': secrets.workerCredentialExecutor,
        'worker-ingress-password': secrets.worker,
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'ql3-e2e-postgres-init', namespace: NAMESPACE },
      data: { '001-roles.sh': initScript },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: POSTGRES_NAME, namespace: NAMESPACE },
      spec: {
        selector: { 'app.kubernetes.io/name': POSTGRES_NAME },
        ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: POSTGRES_NAME,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/name': POSTGRES_NAME },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [
          {
            name: 'postgres',
            image: POSTGRES_RUNTIME_IMAGE,
            imagePullPolicy: 'Never',
            env: [
              { name: 'POSTGRES_USER', value: 'postgres' },
              {
                name: 'POSTGRES_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'postgres-password',
                  },
                },
              },
              { name: 'POSTGRES_DB', value: 'postgres' },
              {
                name: 'QL3_MIGRATION_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'migration-password',
                  },
                },
              },
              {
                name: 'QL3_RUNTIME_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'runtime-password',
                  },
                },
              },
              {
                name: 'QL3_ADMIN_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'admin-password',
                  },
                },
              },
              {
                name: 'QL3_AUTOMATION_MANAGER_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'automation-manager-password',
                  },
                },
              },
              {
                name: 'QL3_APPROVAL_MANAGER_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'approval-manager-password',
                  },
                },
              },
              {
                name: 'QL3_RUN_MANAGER_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'run-manager-password',
                  },
                },
              },
              {
                name: 'QL3_PACKAGE_MANAGER_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'package-manager-password',
                  },
                },
              },
              {
                name: 'QL3_PACKAGE_EXECUTOR_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'package-executor-password',
                  },
                },
              },
              {
                name: 'QL3_WORKER_CREDENTIAL_MANAGER_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'worker-credential-manager-password',
                  },
                },
              },
              {
                name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'worker-credential-executor-password',
                  },
                },
              },
              {
                name: 'QL3_WORKER_INGRESS_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-postgres-auth',
                    key: 'worker-ingress-password',
                  },
                },
              },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
            },
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
            volumeMounts: [
              { name: 'data', mountPath: '/var/lib/postgresql' },
              {
                name: 'init',
                mountPath: '/docker-entrypoint-initdb.d',
                readOnly: true,
              },
            ],
          },
        ],
        volumes: [
          { name: 'data', emptyDir: { sizeLimit: '2Gi' } },
          {
            name: 'init',
            configMap: {
              name: 'ql3-e2e-postgres-init',
              defaultMode: 365,
            },
          },
        ],
      },
    },
  ];
}

function registryResources(fixture, certificate, registryCredential) {
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-e2e-registry-tls', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'ca.crt': certificate.ca,
        'tls.crt': certificate.cert,
        'tls.key': certificate.key,
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-e2e-registry-auth', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        authorization: registryCredential.authorization,
        'credentials.json': registryCredential.file,
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'ql3-e2e-fixture', namespace: NAMESPACE },
      data: {
        'fixture.cjs': fs.readFileSync(FIXTURE_SCRIPT, 'utf8'),
        'fixture.json': JSON.stringify(fixture),
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: REGISTRY_NAME, namespace: NAMESPACE },
      spec: {
        selector: { 'app.kubernetes.io/name': REGISTRY_NAME },
        ports: [{ name: 'https', port: 443, targetPort: 8443 }],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: REGISTRY_NAME,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/name': REGISTRY_NAME },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        securityContext: commonSecurityContext(),
        containers: [
          {
            name: 'registry',
            image: ADMIN_IMAGE,
            imagePullPolicy: 'Never',
            command: ['node', '/opt/ql3-e2e/fixture.cjs'],
            env: [
              { name: 'QL3_E2E_MODE', value: 'registry' },
              {
                name: 'QL3_E2E_FIXTURE_FILE',
                value: '/opt/ql3-e2e/fixture.json',
              },
              {
                name: 'QL3_E2E_REGISTRY_CERT_FILE',
                value: '/var/run/ql3-e2e-registry/tls.crt',
              },
              {
                name: 'QL3_E2E_REGISTRY_KEY_FILE',
                value: '/var/run/ql3-e2e-registry/tls.key',
              },
              { name: 'QL3_E2E_REGISTRY_PORT', value: '8443' },
              {
                name: 'QL3_E2E_REGISTRY_AUTHORIZATION',
                valueFrom: {
                  secretKeyRef: {
                    name: 'ql3-e2e-registry-auth',
                    key: 'authorization',
                  },
                },
              },
            ],
            securityContext: containerSecurityContext(),
            ports: [{ name: 'https', containerPort: 8443 }],
            readinessProbe: {
              tcpSocket: { port: 'https' },
              periodSeconds: 2,
              failureThreshold: 30,
            },
            resources: {
              requests: { cpu: '25m', memory: '32Mi' },
              limits: { cpu: '250m', memory: '128Mi' },
            },
            volumeMounts: [
              {
                name: 'fixture',
                mountPath: '/opt/ql3-e2e',
                readOnly: true,
              },
              {
                name: 'tls',
                mountPath: '/var/run/ql3-e2e-registry',
                readOnly: true,
              },
            ],
          },
        ],
        volumes: [
          {
            name: 'fixture',
            configMap: { name: 'ql3-e2e-fixture', defaultMode: 292 },
          },
          {
            name: 'tls',
            secret: {
              secretName: 'ql3-e2e-registry-tls',
              defaultMode: 292,
            },
          },
        ],
      },
    },
  ];
}

function postgresEnvironment(role, passwordKey, applicationName) {
  return [
    { name: 'QL3_POSTGRES_TLS_MODE', value: 'disable' },
    { name: 'QL3_POSTGRES_ALLOW_INSECURE', value: 'true' },
    { name: 'QL3_POSTGRES_APPLICATION_NAME', value: applicationName },
    { name: `QL3_POSTGRES_${role}_HOST`, value: POSTGRES_NAME },
    { name: `QL3_POSTGRES_${role}_PORT`, value: '5432' },
    { name: `QL3_POSTGRES_${role}_DATABASE`, value: 'qinglong' },
    {
      name: `QL3_POSTGRES_${role}_USER`,
      value: `ql3_${role.toLowerCase().replaceAll('-', '_')}`,
    },
    {
      name: `QL3_POSTGRES_${role}_PASSWORD`,
      valueFrom: {
        secretKeyRef: {
          name: 'ql3-e2e-postgres-auth',
          key: passwordKey,
        },
      },
    },
  ];
}

function migrationJob() {
  const [job] = readYamlDocuments(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operations/base/migrate-job.yaml',
    ),
  );
  job.metadata.namespace = NAMESPACE;
  job.spec.activeDeadlineSeconds = 300;
  job.spec.template.spec.serviceAccountName = CONTROL_SERVICE_ACCOUNT;
  const container = job.spec.template.spec.containers[0];
  container.image = CONTROL_IMAGE;
  container.imagePullPolicy = 'Never';
  container.env = postgresEnvironment(
    'MIGRATION',
    'migration-password',
    'qinglong3-plugin-e2e-migration',
  );
  container.volumeMounts = [{ name: 'tmp', mountPath: '/tmp' }];
  job.spec.template.spec.volumes = [
    {
      name: 'tmp',
      emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
    },
  ];
  return job;
}

function seedJob(name, mode) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-plugin-package-e2e-seed',
            'app.kubernetes.io/part-of': 'qinglong3',
          },
        },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          securityContext: commonSecurityContext(),
          containers: [
            {
              name: 'seed',
              image: ADMIN_IMAGE,
              imagePullPolicy: 'Never',
              command: ['node', '/opt/ql3-e2e/fixture.cjs'],
              env: [
                { name: 'QL3_E2E_MODE', value: mode },
                {
                  name: 'QL3_E2E_FIXTURE_FILE',
                  value: '/opt/ql3-e2e/fixture.json',
                },
                {
                  name: 'NODE_PATH',
                  value: '/opt/qinglong/node_modules',
                },
                { name: 'QL3_E2E_POSTGRES_HOST', value: POSTGRES_NAME },
                { name: 'QL3_E2E_POSTGRES_PORT', value: '5432' },
                { name: 'QL3_E2E_POSTGRES_DATABASE', value: 'qinglong' },
                {
                  name: 'QL3_E2E_POSTGRES_PACKAGE_MANAGER_USER',
                  value: 'ql3_package_manager',
                },
                {
                  name: 'QL3_E2E_POSTGRES_PACKAGE_MANAGER_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ql3-e2e-postgres-auth',
                      key: 'package-manager-password',
                    },
                  },
                },
                {
                  name: 'QL3_E2E_POSTGRES_PACKAGE_EXECUTOR_USER',
                  value: 'ql3_package_executor',
                },
                {
                  name: 'QL3_E2E_POSTGRES_PACKAGE_EXECUTOR_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ql3-e2e-postgres-auth',
                      key: 'package-executor-password',
                    },
                  },
                },
              ],
              securityContext: containerSecurityContext(),
              resources: {
                requests: { cpu: '25m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
              volumeMounts: [
                {
                  name: 'fixture',
                  mountPath: '/opt/ql3-e2e',
                  readOnly: true,
                },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            {
              name: 'fixture',
              configMap: { name: 'ql3-e2e-fixture', defaultMode: 292 },
            },
            {
              name: 'tmp',
              emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
            },
          ],
        },
      },
    },
  };
}

function recoveryResources(fixture, jobName) {
  const rbac = readYamlDocuments(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/base/rbac.yaml',
    ),
  );
  for (const value of rbac) {
    value.metadata.namespace = NAMESPACE;
    if (value.kind === 'RoleBinding') {
      for (const subject of value.subjects) subject.namespace = NAMESPACE;
    }
  }
  const [job] = readYamlDocuments(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/base/recover-job.yaml',
    ),
  );
  job.metadata.name = jobName;
  job.metadata.namespace = NAMESPACE;
  job.spec.activeDeadlineSeconds = 300;
  const container = job.spec.template.spec.containers[0];
  container.image = ADMIN_IMAGE;
  container.imagePullPolicy = 'Never';
  container.env = [
    {
      name: 'QL3_CLUSTER_IDENTITY',
      valueFrom: {
        configMapKeyRef: {
          name: 'ql3-plugin-package-recovery-config',
          key: 'cluster-identity',
        },
      },
    },
    {
      name: 'QL3_KUBERNETES_NAMESPACE',
      valueFrom: {
        fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' },
      },
    },
    {
      name: 'QL3_PLUGIN_PACKAGE_OCI_REGISTRIES',
      valueFrom: {
        configMapKeyRef: {
          name: 'ql3-plugin-package-recovery-config',
          key: 'oci-registries',
        },
      },
    },
    {
      name: 'QL3_PLUGIN_PACKAGE_PUBLISHER_TRUST_FILE',
      value: '/var/run/qinglong3/plugin-package-trust/publishers.json',
    },
    {
      name: 'NODE_EXTRA_CA_CERTS',
      value: '/var/run/secrets/ql3-e2e-registry/ca.crt',
    },
    {
      name: 'QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE',
      value: '/var/run/secrets/ql3-e2e-registry-auth/credentials.json',
    },
    { name: 'QL3_PLUGIN_PACKAGE_OCI_TIMEOUT_MS', value: '15000' },
    { name: 'QL3_PLUGIN_PACKAGE_RECOVERY_PAGE_SIZE', value: '8' },
    { name: 'QL3_PLUGIN_PACKAGE_RECOVERY_MAX_PAGES', value: '8' },
    ...postgresEnvironment(
      'PACKAGE_EXECUTOR',
      'package-executor-password',
      'qinglong3-plugin-package-recovery-e2e',
    ),
  ];
  container.volumeMounts = [
    { name: 'tmp', mountPath: '/tmp' },
    {
      name: 'plugin-package-trust',
      mountPath: '/var/run/qinglong3/plugin-package-trust',
      readOnly: true,
    },
    {
      name: 'registry-ca',
      mountPath: '/var/run/secrets/ql3-e2e-registry',
      readOnly: true,
    },
    {
      name: 'registry-credentials',
      mountPath: '/var/run/secrets/ql3-e2e-registry-auth',
      readOnly: true,
    },
  ];
  job.spec.template.spec.volumes = [
    {
      name: 'tmp',
      emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
    },
    {
      name: 'plugin-package-trust',
      configMap: {
        name: 'ql3-plugin-publisher-trust',
        defaultMode: 292,
        items: [{ key: 'publishers.json', path: 'publishers.json' }],
      },
    },
    {
      name: 'registry-ca',
      secret: {
        secretName: 'ql3-e2e-registry-tls',
        defaultMode: 292,
        items: [{ key: 'ca.crt', path: 'ca.crt' }],
      },
    },
    {
      name: 'registry-credentials',
      secret: {
        secretName: 'ql3-e2e-registry-auth',
        defaultMode: 288,
        items: [{ key: 'credentials.json', path: 'credentials.json' }],
      },
    },
  ];
  return [
    ...rbac,
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-plugin-package-recovery-config',
        namespace: NAMESPACE,
      },
      data: {
        'cluster-identity': 'ql3-plugin-package-recovery-e2e-cluster',
        'oci-registries': fixture.registry,
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-plugin-publisher-trust',
        namespace: NAMESPACE,
      },
      data: { 'publishers.json': JSON.stringify(fixture.trust) },
    },
    job,
  ];
}

function waitForJob(
  name,
  expectedStatus = 'complete',
  timeoutMs = 5 * 60 * 1000,
) {
  if (!['complete', 'failed'].includes(expectedStatus)) {
    fail('expected Job status is invalid');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
    const complete = job.status?.conditions?.find(
      (condition) =>
        condition.type === 'Complete' && condition.status === 'True',
    );
    if (complete) {
      if (expectedStatus !== 'complete') {
        fail(`${name} completed but failure was required`);
      }
      return job;
    }
    const failed = job.status?.conditions?.find(
      (condition) => condition.type === 'Failed' && condition.status === 'True',
    );
    if (failed) {
      if (expectedStatus === 'failed') return job;
      const logs = kubectl(
        ['-n', NAMESPACE, 'logs', `job/${name}`, '--all-containers=true'],
        { capture: true, quiet: true, allowFailure: true },
      );
      fail(
        `${name} failed: ${failed.reason ?? 'unknown'}\n${logs.stdout}\n${
          logs.stderr
        }`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
  const facts = kubectl(['-n', NAMESPACE, 'get', 'job,pod', '-o', 'wide'], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  const logs = kubectl(
    ['-n', NAMESPACE, 'logs', `job/${name}`, '--all-containers=true'],
    { capture: true, quiet: true, allowFailure: true },
  );
  fail(
    `${name} timed out after ${timeoutMs}ms\n${facts.stdout}\n${logs.stdout}\n${logs.stderr}`,
  );
}

function jobLog(name) {
  return kubectl(
    ['-n', NAMESPACE, 'logs', `job/${name}`, '--all-containers=true'],
    { capture: true, quiet: true },
  ).stdout;
}

function lastJsonLine(output, predicate) {
  const values = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const value = values.findLast(predicate);
  assert.ok(value, `expected JSON evidence was absent from:\n${output}`);
  return value;
}

function canI(verb, resource) {
  const result = kubectl(
    [
      'auth',
      'can-i',
      verb,
      resource,
      '--namespace',
      NAMESPACE,
      '--as',
      `system:serviceaccount:${NAMESPACE}:${RECOVERY_SERVICE_ACCOUNT}`,
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  assert.ok(result.status === 0 || result.status === 1);
  assert.ok(result.stdout === 'yes' || result.stdout === 'no');
  return result.stdout === 'yes';
}

function upgradeStageEvidence(fixture, transitionReceiptCount) {
  const generationDigest = fixture.upgrade.generation.generationDigest;
  assert.match(generationDigest, /^[0-9a-f]{64}$/);
  const sql = `
SELECT json_build_object(
  'state', (
    SELECT state FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'previousActiveLockDigest', (
    SELECT previous_active_lock_digest FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'activeLockDigest', (
    SELECT active_lock_digest FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'mutationCount', (
    SELECT count(*) FROM ql3.plugin_package_install_mutations
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'transitionReceiptCount', (
    SELECT count(*)
    FROM ql3.plugin_package_secret_binding_transition_receipts
    WHERE generation_digest = '${generationDigest}'
  ),
  'candidateRevisionCount', (
    SELECT count(*) FROM ql3.plugin_package_materialized_revisions
    WHERE generation_digest = '${generationDigest}'
  )
)::text;
`.trim();
  const output = kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      POSTGRES_NAME,
      '--',
      'psql',
      '--username',
      'postgres',
      '--dbname',
      'qinglong',
      '--tuples-only',
      '--no-align',
      '--command',
      sql,
    ],
    { capture: true, quiet: true },
  ).stdout;
  const value = JSON.parse(output);
  assert.equal(value.state, 'staged');
  assert.equal(value.previousActiveLockDigest, fixture.initial.lock.lockDigest);
  assert.equal(value.activeLockDigest, fixture.initial.lock.lockDigest);
  assert.equal(value.mutationCount, 2);
  assert.equal(value.transitionReceiptCount, transitionReceiptCount);
  assert.equal(value.candidateRevisionCount, 0);
  return value;
}

function databaseEvidence(fixture) {
  const initialGenerationDigest = fixture.initial.generation.generationDigest;
  const upgradeGenerationDigest = fixture.upgrade.generation.generationDigest;
  assert.match(initialGenerationDigest, /^[0-9a-f]{64}$/);
  assert.match(upgradeGenerationDigest, /^[0-9a-f]{64}$/);
  const sql = `
SELECT json_build_object(
  'migrationCount', (SELECT count(*) FROM ql3.schema_migrations),
  'capabilityVersion', (
    SELECT contract_version
    FROM ql3.schema_capabilities
    WHERE contract_name = 'control-core'
  ),
  'initialState', (
    SELECT state
    FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.initial.installationId}'
  ),
  'initialActiveLockDigest', (
    SELECT active_lock_digest
    FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.initial.installationId}'
  ),
  'upgradeState', (
    SELECT state
    FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'upgradePreviousActiveLockDigest', (
    SELECT previous_active_lock_digest
    FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'upgradeActiveLockDigest', (
    SELECT active_lock_digest
    FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'upgradeFailureReason', (
    SELECT record_json #>> '{failure,reason}'
    FROM ql3.plugin_package_installs
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'initialMutationCount', (
    SELECT count(*)
    FROM ql3.plugin_package_install_mutations
    WHERE installation_id = '${fixture.initial.installationId}'
  ),
  'upgradeMutationCount', (
    SELECT count(*)
    FROM ql3.plugin_package_install_mutations
    WHERE installation_id = '${fixture.upgrade.installationId}'
  ),
  'headInstallationId', (
    SELECT installation_id
    FROM ql3.plugin_package_install_heads
    WHERE project_id = 'default' AND package_name = 'e2e-monitor'
  ),
  'transitionReceiptCount', (
    SELECT count(*)
    FROM ql3.plugin_package_secret_binding_transition_receipts
    WHERE generation_digest = '${upgradeGenerationDigest}'
  ),
  'initialRevisionCount', (
    SELECT count(*) FROM ql3.plugin_package_materialized_revisions
    WHERE generation_digest = '${initialGenerationDigest}'
  ),
  'upgradeRevisionCount', (
    SELECT count(*) FROM ql3.plugin_package_materialized_revisions
    WHERE generation_digest = '${upgradeGenerationDigest}'
  ),
  'recoverableCount', (
    SELECT count(*)
    FROM ql3.plugin_package_installs
    WHERE state IN ('queued', 'staged', 'activating')
  )
)::text;
`.trim();
  const output = kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      POSTGRES_NAME,
      '--',
      'psql',
      '--username',
      'postgres',
      '--dbname',
      'qinglong',
      '--tuples-only',
      '--no-align',
      '--command',
      sql,
    ],
    { capture: true, quiet: true },
  ).stdout;
  const value = JSON.parse(output);
  assert.equal(value.migrationCount, 65);
  assert.equal(value.capabilityVersion, 64);
  assert.equal(value.initialState, 'active');
  assert.equal(value.initialActiveLockDigest, fixture.initial.lock.lockDigest);
  assert.equal(value.upgradeState, 'failed');
  assert.equal(
    value.upgradePreviousActiveLockDigest,
    fixture.initial.lock.lockDigest,
  );
  assert.equal(value.upgradeActiveLockDigest, fixture.initial.lock.lockDigest);
  assert.equal(value.upgradeFailureReason, 'activation_fact_conflict');
  assert.equal(value.initialMutationCount, 4);
  assert.equal(value.upgradeMutationCount, 3);
  assert.equal(value.headInstallationId, fixture.upgrade.installationId);
  assert.equal(value.transitionReceiptCount, 1);
  assert.equal(value.initialRevisionCount, 1);
  assert.equal(value.upgradeRevisionCount, 0);
  assert.equal(value.recoverableCount, 0);
  return value;
}

function activePointerEvidence(fixture) {
  const values = kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'configmaps',
    '-l',
    'qinglong.io/plugin-package-active=v2',
  ]);
  assert.equal(values.items.length, 1);
  const configMap = values.items[0];
  const pointer = JSON.parse(configMap.data['active.json']);
  assert.equal(pointer.intent.installationId, fixture.initial.installationId);
  assert.equal(pointer.intent.lockDigest, fixture.initial.lock.lockDigest);
  assert.equal(pointer.receipt.generation, 1);
  return Object.freeze({
    name: configMap.metadata.name,
    uid: configMap.metadata.uid,
    resourceVersion: configMap.metadata.resourceVersion,
    activeJson: configMap.data['active.json'],
    intentDigest: pointer.intent.intentDigest,
    activationRef: pointer.receipt.activationRef,
  });
}

function reportActivePointer(pointer) {
  return Object.freeze({
    name: pointer.name,
    uid: pointer.uid,
    resourceVersion: pointer.resourceVersion,
    activeJsonDigest: createHash('sha256')
      .update(pointer.activeJson, 'utf8')
      .digest('hex'),
    intentDigest: pointer.intentDigest,
    activationRef: pointer.activationRef,
  });
}

function registryEvidence(fixture) {
  const output = kubectl(
    ['-n', NAMESPACE, 'logs', REGISTRY_NAME, '-c', 'registry'],
    { capture: true, quiet: true },
  ).stdout;
  const events = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((value) => value.schema === REGISTRY_EVENT_SCHEMA);
  const packageRequests = events.filter((event) => event.path !== '/v2/');
  const expectedPaths = [
    ...fixture.initial.routes.map((routeValue) => routeValue.path),
    ...fixture.upgrade.routes.flatMap((routeValue) => [
      routeValue.path,
      routeValue.path,
    ]),
  ].sort();
  assert.equal(packageRequests.length, expectedPaths.length);
  assert.deepEqual(
    packageRequests.map((event) => event.path).sort(),
    expectedPaths,
  );
  assert.ok(packageRequests.every((event) => event.status === 200));
  assert.ok(packageRequests.every((event) => event.authenticated === true));
  return Object.freeze({
    https: true,
    authentication: 'exact-registry-basic',
    authenticatedRequestCount: packageRequests.length,
    requestCount: packageRequests.length,
    uniquePaths: new Set(packageRequests.map((event) => event.path)).size,
    initialRequestCount: fixture.initial.routes.length,
    upgradeRequestCount: fixture.upgrade.routes.length * 2,
    redirects: 0,
  });
}

function recoveryRbacEvidence() {
  const role = kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'role',
    RECOVERY_SERVICE_ACCOUNT,
  ]);
  assert.deepEqual(role.rules, [
    {
      apiGroups: [''],
      resources: ['configmaps'],
      verbs: ['get', 'create', 'update'],
    },
  ]);
  const decisions = {
    getConfigMaps: canI('get', 'configmaps'),
    createConfigMaps: canI('create', 'configmaps'),
    updateConfigMaps: canI('update', 'configmaps'),
    listConfigMaps: canI('list', 'configmaps'),
    deleteConfigMaps: canI('delete', 'configmaps'),
    getSecrets: canI('get', 'secrets'),
  };
  assert.deepEqual(decisions, {
    getConfigMaps: true,
    createConfigMaps: true,
    updateConfigMaps: true,
    listConfigMaps: false,
    deleteConfigMaps: false,
    getSecrets: false,
  });
  return Object.freeze(decisions);
}

function applyRuntimeAfterRecovery(recoveryJob, migrationJobValue, secrets) {
  const recoveryComplete = recoveryJob.status.conditions.find(
    (condition) => condition.type === 'Complete' && condition.status === 'True',
  );
  const migrationComplete = migrationJobValue.status.conditions.find(
    (condition) => condition.type === 'Complete' && condition.status === 'True',
  );
  assert.ok(recoveryComplete?.lastTransitionTime);
  assert.ok(migrationComplete?.lastTransitionTime);
  assert.ok(
    Date.parse(recoveryComplete.lastTransitionTime) >=
      Date.parse(migrationComplete.lastTransitionTime),
  );
  const annotation = {
    'qinglong.io/plugin-recovery-job-uid': recoveryJob.metadata.uid,
    'qinglong.io/plugin-recovery-resource-version':
      recoveryJob.metadata.resourceVersion,
    'qinglong.io/plugin-recovery-completed-at':
      recoveryComplete.lastTransitionTime,
    'qinglong.io/migration-job-uid': migrationJobValue.metadata.uid,
    'qinglong.io/migration-completed-at': migrationComplete.lastTransitionTime,
  };
  apply(
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-cluster-control-runtime',
        namespace: NAMESPACE,
      },
      type: 'Opaque',
      stringData: {
        'postgres-runtime-url': `postgresql://ql3_runtime:${secrets.runtime}@${POSTGRES_NAME}:5432/qinglong`,
        'api-credential-pepper': randomBytes(32).toString('base64url'),
      },
    },
    'create runtime-only credential after recovery success',
  );
  const names = [
    'service-account.yaml',
    'service.yaml',
    'pod-disruption-budget.yaml',
    'deployment.yaml',
  ];
  const resources = names.flatMap((name) =>
    readYamlDocuments(
      path.join(ROOT, 'deploy/kubernetes/ql3-cluster/base', name),
    ),
  );
  for (const resource of resources) {
    resource.metadata.namespace = NAMESPACE;
    if (resource.kind !== 'Deployment') continue;
    resource.metadata.annotations = annotation;
    const container = resource.spec.template.spec.containers[0];
    container.image = CONTROL_IMAGE;
    container.imagePullPolicy = 'Never';
    container.env = [
      { name: 'QL_DEPLOYMENT_PROFILE', value: 'cluster-control' },
      { name: 'QL3_CLUSTER_CONTROL_ENABLED', value: 'true' },
      { name: 'QL3_CLUSTER_HTTP_HOST', value: '0.0.0.0' },
      { name: 'QL3_CLUSTER_HTTP_PORT', value: '5800' },
      { name: 'QL3_CLUSTER_HTTP_DRAIN_TIMEOUT_MS', value: '10000' },
      { name: 'QL3_POSTGRES_TLS_MODE', value: 'disable' },
      { name: 'QL3_POSTGRES_ALLOW_INSECURE', value: 'true' },
      { name: 'QL3_POSTGRES_MAX_CONNECTIONS', value: '4' },
      {
        name: 'QL3_POSTGRES_APPLICATION_NAME',
        value: 'qinglong3-plugin-recovery-e2e-runtime',
      },
      {
        name: 'QL3_CLUSTER_REPLICA_ID',
        valueFrom: {
          fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.name' },
        },
      },
      {
        name: 'QL3_POSTGRES_RUNTIME_URL',
        valueFrom: {
          secretKeyRef: {
            name: 'ql3-cluster-control-runtime',
            key: 'postgres-runtime-url',
          },
        },
      },
      {
        name: 'QL3_API_CREDENTIAL_PEPPER',
        valueFrom: {
          secretKeyRef: {
            name: 'ql3-cluster-control-runtime',
            key: 'api-credential-pepper',
          },
        },
      },
    ];
    container.volumeMounts = [{ name: 'tmp', mountPath: '/tmp' }];
    resource.spec.template.spec.volumes = [
      {
        name: 'tmp',
        emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
      },
    ];
  }
  for (const resource of resources) {
    apply(resource, `deployment controller apply ${resource.kind}`);
  }
  kubectl(
    [
      '-n',
      NAMESPACE,
      'rollout',
      'status',
      'deployment/ql3-cluster-control',
      '--timeout=5m',
    ],
    { capture: true, quiet: true },
  );
  const deployment = kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'deployment',
    'ql3-cluster-control',
  ]);
  assert.equal(deployment.status.availableReplicas, 2);
  assert.deepEqual(deployment.metadata.annotations, {
    ...deployment.metadata.annotations,
    ...annotation,
  });
  for (const [key, value] of Object.entries(annotation)) {
    assert.equal(deployment.metadata.annotations[key], value);
  }
  assert.ok(
    Date.parse(deployment.metadata.creationTimestamp) >=
      Date.parse(recoveryComplete.lastTransitionTime),
  );
  const pods = kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    'app.kubernetes.io/name=ql3-cluster-control',
  ]);
  assert.equal(pods.items.length, 2);
  assert.equal(new Set(pods.items.map((pod) => pod.spec.nodeName)).size, 2);
  assert.ok(
    pods.items.every(
      (pod) =>
        pod.status.containerStatuses?.[0]?.ready === true &&
        pod.spec.automountServiceAccountToken === false,
    ),
  );
  return Object.freeze({
    replicas: deployment.status.availableReplicas,
    creationTimestamp: deployment.metadata.creationTimestamp,
    recoveryJobUid: annotation['qinglong.io/plugin-recovery-job-uid'],
    recoveryCompletedAt: annotation['qinglong.io/plugin-recovery-completed-at'],
    nodes: pods.items.map((pod) => pod.spec.nodeName).sort(),
    imageIds: [
      ...new Set(
        pods.items.map((pod) => pod.status.containerStatuses[0].imageID),
      ),
    ],
  });
}

function assertRuntimeCannotReadPluginAuthority() {
  const result = kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      POSTGRES_NAME,
      '--',
      'sh',
      '-c',
      'PGPASSWORD="$QL3_RUNTIME_PASSWORD" psql --host=ql3-postgres-live --username=ql3_runtime --dbname=qinglong --command="SELECT count(*) FROM ql3.plugin_package_installs"',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permission denied/i);
}

function jobImageId(name) {
  const pods = kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    `job-name=${name}`,
  ]);
  assert.equal(pods.items.length, 1);
  return pods.items[0].status.containerStatuses[0].imageID;
}

function diagnostics() {
  if (!kubeconfig || !fs.existsSync(kubeconfig)) return;
  const snapshot = kubectl(
    ['-n', NAMESPACE, 'get', 'pod,job,deployment,configmap', '-o', 'wide'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (snapshot.stdout) process.stderr.write(`${snapshot.stdout}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  if (process.env.QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE !== '1') {
    fail(
      'Refusing to create a live cluster without QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE=1',
    );
  }
  const revision = sourceRevision();
  const clusterName = exactClusterName();
  const existing = kind(['get', 'clusters'], {
    capture: true,
    quiet: true,
    allowFailure: true,
  })
    .stdout.split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (existing.includes(clusterName)) {
    fail(
      `Refusing to reuse or delete pre-existing Kind cluster ${clusterName}`,
    );
  }
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-plugin-recovery-e2e-'),
  );
  kubeconfig = path.join(root, 'kubeconfig');
  const kindConfig = path.join(root, 'kind.yaml');
  const fixtureArchitecture = architecture();
  const fixture = createFixture({
    registry: REGISTRY_HOST,
    architecture: fixtureArchitecture,
  });
  const certificate = createRegistryCertificate(root);
  const secrets = {
    postgres: randomSecret(),
    migration: randomSecret(),
    runtime: randomSecret(),
    admin: randomSecret(),
    automationManager: randomSecret(),
    approvalManager: randomSecret(),
    runManager: randomSecret(),
    packageManager: randomSecret(),
    packageExecutor: randomSecret(),
    workerCredentialManager: randomSecret(),
    workerCredentialExecutor: randomSecret(),
    worker: randomSecret(),
    registry: randomSecret(),
  };
  const registryCredential = {
    authorization: `Basic ${Buffer.from(
      `ql3-e2e:${secrets.registry}`,
      'utf8',
    ).toString('base64')}`,
    file: JSON.stringify({
      schema: 'qinglong/plugin-package-registry-credentials@v1',
      credentials: [
        {
          registry: fixture.registry,
          scheme: 'basic',
          username: 'ql3-e2e',
          password: secrets.registry,
        },
      ],
    }),
  };
  let created = false;
  const startedAt = Date.now();
  try {
    buildImages(revision);
    const adminSourceRevision = imageSourceRevision(ADMIN_IMAGE);
    const controlSourceRevision = imageSourceRevision(CONTROL_IMAGE);
    assert.equal(adminSourceRevision, revision);
    assert.equal(controlSourceRevision, revision);
    const adminBuildId = imageId(ADMIN_IMAGE);
    const controlBuildId = imageId(CONTROL_IMAGE);
    ensurePostgresImage();
    fs.writeFileSync(
      kindConfig,
      `${yaml.dump({
        kind: 'Cluster',
        apiVersion: 'kind.x-k8s.io/v1alpha4',
        nodes: [
          { role: 'control-plane' },
          { role: 'worker' },
          { role: 'worker' },
        ],
      })}`,
      { mode: 0o600 },
    );
    kind(
      [
        'create',
        'cluster',
        '--name',
        clusterName,
        '--image',
        KIND_NODE_IMAGE,
        '--config',
        kindConfig,
        '--kubeconfig',
        kubeconfig,
        '--wait',
        '5m',
      ],
      {
        env: kindCreateEnvironment(clusterName),
        label: `create isolated Kind cluster ${clusterName}`,
      },
    );
    created = true;
    for (const image of [
      ADMIN_IMAGE,
      CONTROL_IMAGE,
      POSTGRES_RUNTIME_IMAGE,
    ]) {
      kind(
        [
          'load',
          'docker-image',
          '--name',
          clusterName,
          '--nodes',
          `${clusterName}-control-plane,${clusterName}-worker,${clusterName}-worker2`,
          image,
        ],
        { label: `load ${image} into ${clusterName}` },
      );
    }
    apply(
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: NAMESPACE },
      },
      'create Plugin Package recovery E2E namespace',
    );
    apply(
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: CONTROL_SERVICE_ACCOUNT,
          namespace: NAMESPACE,
        },
        automountServiceAccountToken: false,
      },
      'create migration/runtime ServiceAccount',
    );
    for (const resource of postgresResources(secrets)) {
      apply(resource, `apply PostgreSQL fixture ${resource.kind}`);
    }
    for (const resource of registryResources(
      fixture,
      certificate,
      registryCredential,
    )) {
      apply(resource, `apply OCI fixture ${resource.kind}`);
    }
    kubectl(
      [
        '-n',
        NAMESPACE,
        'wait',
        '--for=condition=Ready',
        `pod/${POSTGRES_NAME}`,
        '--timeout=5m',
      ],
      { capture: true, quiet: true },
    );
    kubectl(
      [
        '-n',
        NAMESPACE,
        'wait',
        '--for=condition=Ready',
        `pod/${REGISTRY_NAME}`,
        '--timeout=2m',
      ],
      { capture: true, quiet: true },
    );

    apply(migrationJob(), 'create reviewed migration Job');
    const migrated = waitForJob('ql3-cluster-migration');
    const migrationLog = jobLog('ql3-cluster-migration');
    lastJsonLine(
      migrationLog,
      (value) => value.event === 'migration_completed',
    );

    apply(
      seedJob(INITIAL_SEED_JOB, 'seed-initial'),
      'persist initial durable queued Plugin Package installation',
    );
    waitForJob(INITIAL_SEED_JOB);
    const initialSeed = lastJsonLine(
      jobLog(INITIAL_SEED_JOB),
      (value) => value.event === 'seed_completed',
    );
    assert.equal(initialSeed.phase, 'initial');
    assert.equal(initialSeed.status, 'created');
    assert.equal(initialSeed.state, 'queued');
    assert.equal(initialSeed.lockDigest, fixture.initial.lock.lockDigest);

    for (const resource of recoveryResources(fixture, INITIAL_RECOVERY_JOB)) {
      apply(resource, `apply initial recovery ${resource.kind}`);
    }
    const initialRecovered = waitForJob(INITIAL_RECOVERY_JOB);
    const initialCompleted = lastJsonLine(
      jobLog(INITIAL_RECOVERY_JOB),
      (value) => value.event === 'recovery_completed',
    );
    assert.equal(initialCompleted.recovery.safeToAdmit, true);
    assert.equal(initialCompleted.recovery.remaining, false);
    assert.equal(initialCompleted.recovery.manualRequired, 0);
    const pointerBeforeUpgrade = activePointerEvidence(fixture);

    apply(
      seedJob(UPGRADE_SEED_JOB, 'seed-upgrade'),
      'persist invalid durable queued Plugin Package upgrade',
    );
    waitForJob(UPGRADE_SEED_JOB);
    const upgradeSeed = lastJsonLine(
      jobLog(UPGRADE_SEED_JOB),
      (value) => value.event === 'seed_completed',
    );
    assert.equal(upgradeSeed.phase, 'upgrade');
    assert.equal(upgradeSeed.status, 'created');
    assert.equal(upgradeSeed.state, 'queued');
    assert.equal(upgradeSeed.lockDigest, fixture.upgrade.lock.lockDigest);

    for (const resource of recoveryResources(fixture, UPGRADE_STAGE_JOB)) {
      apply(resource, `apply upgrade staging recovery ${resource.kind}`);
    }
    const stagedUpgrade = waitForJob(UPGRADE_STAGE_JOB, 'failed');
    const stagedFailureCondition = stagedUpgrade.status.conditions.find(
      (condition) => condition.type === 'Failed' && condition.status === 'True',
    );
    assert.ok(stagedFailureCondition?.lastTransitionTime);
    const stageFailure = lastJsonLine(
      jobLog(UPGRADE_STAGE_JOB),
      (value) => value.event === 'recovery_failed',
    );
    assert.equal(
      stageFailure.name,
      'ClusterPluginPackageRecoveryRequiredError',
    );
    const stagedDatabase = upgradeStageEvidence(fixture, 0);
    assert.deepEqual(activePointerEvidence(fixture), pointerBeforeUpgrade);

    apply(
      seedJob(TRANSITION_JOB, 'commit-transition'),
      'commit durable no-secret binding transition receipt',
    );
    const committedTransition = waitForJob(TRANSITION_JOB);
    const transition = lastJsonLine(
      jobLog(TRANSITION_JOB),
      (value) => value.event === 'transition_completed',
    );
    assert.equal(transition.status, 'created');
    assert.equal(
      transition.generationDigest,
      fixture.upgrade.generation.generationDigest,
    );
    assert.equal(transition.bindingDigest, null);
    upgradeStageEvidence(fixture, 1);

    for (const resource of recoveryResources(fixture, UPGRADE_REJECTION_JOB)) {
      apply(resource, `apply upgrade rejection recovery ${resource.kind}`);
    }
    const rejectedUpgrade = waitForJob(UPGRADE_REJECTION_JOB);
    const rejectionCompleted = lastJsonLine(
      jobLog(UPGRADE_REJECTION_JOB),
      (value) => value.event === 'recovery_completed',
    );
    assert.equal(rejectionCompleted.recovery.safeToAdmit, true);
    assert.equal(rejectionCompleted.recovery.remaining, false);
    assert.equal(rejectionCompleted.recovery.manualRequired, 0);

    const database = databaseEvidence(fixture);
    const pointerAfterRejection = activePointerEvidence(fixture);
    assert.deepEqual(pointerAfterRejection, pointerBeforeUpgrade);
    const oci = registryEvidence(fixture);
    const rbac = recoveryRbacEvidence();
    assertRuntimeCannotReadPluginAuthority();
    const runtime = applyRuntimeAfterRecovery(
      rejectedUpgrade,
      migrated,
      secrets,
    );
    const initialRecoveryImageId = jobImageId(INITIAL_RECOVERY_JOB);
    const stageRecoveryImageId = jobImageId(UPGRADE_STAGE_JOB);
    const rejectionRecoveryImageId = jobImageId(UPGRADE_REJECTION_JOB);
    const migrationImageId = jobImageId('ql3-cluster-migration');
    const postgresPod = kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'pod',
      POSTGRES_NAME,
    ]);
    const report = Object.freeze({
      schema: REPORT_SCHEMA,
      observedAt: new Date().toISOString(),
      sourceRevision: revision,
      passed: true,
      cluster: clusterName,
      architecture: fixtureArchitecture,
      elapsedMs: Date.now() - startedAt,
      images: Object.freeze({
        adminBuildId,
        adminSourceRevision,
        controlBuildId,
        controlSourceRevision,
        postgresRepositoryDigest: POSTGRES_REPOSITORY_DIGEST,
        migrationImageId,
        initialRecoveryImageId,
        stageRecoveryImageId,
        rejectionRecoveryImageId,
        postgresImageId: postgresPod.status.containerStatuses[0].imageID,
      }),
      ordering: Object.freeze({
        migrationJobUid: migrated.metadata.uid,
        migrationCompletedAt: migrated.status.completionTime,
        initialRecoveryJobUid: initialRecovered.metadata.uid,
        initialRecoveryCompletedAt: initialRecovered.status.completionTime,
        upgradeStageJobUid: stagedUpgrade.metadata.uid,
        upgradeStageFailedAt: stagedFailureCondition.lastTransitionTime,
        transitionJobUid: committedTransition.metadata.uid,
        transitionCompletedAt: committedTransition.status.completionTime,
        rejectionRecoveryJobUid: rejectedUpgrade.metadata.uid,
        rejectionRecoveryCompletedAt: rejectedUpgrade.status.completionTime,
        runtimeCreatedAt: runtime.creationTimestamp,
        runtimeBoundRecoveryJobUid: runtime.recoveryJobUid,
      }),
      failedUpgrade: Object.freeze({
        stageFailure: Object.freeze({
          jobUid: stagedUpgrade.metadata.uid,
          reason: stageFailure.name,
          durableState: stagedDatabase.state,
        }),
        transitionReceiptDigest: transition.receiptDigest,
        rejectionReason: database.upgradeFailureReason,
        candidateRevisionCount: database.upgradeRevisionCount,
        activePointerUnchanged: true,
      }),
      database,
      oci,
      kubernetes: Object.freeze({
        activePointer: reportActivePointer(pointerAfterRejection),
        rbac,
      }),
      runtime,
      gates: Object.freeze({
        healthyInitialActivation: true,
        missingTransitionFailedClosed: true,
        invalidUpgradeRejectedBeforeActivation: true,
        activePointerUidUnchanged: true,
        activePointerResourceVersionUnchanged: true,
        activePointerJsonUnchanged: true,
        candidateRevisionAbsent: true,
        exactAuthenticatedOciRequests: true,
        recoveryRbacLeastPrivilege: true,
        runtimeRolledOutAfterRecovery: true,
        passed: true,
      }),
      limitations: Object.freeze([
        'isolated PostgreSQL uses explicit TLS disable; production manifests remain verify-full',
        'the authenticated HTTPS OCI Distribution fixture implements the immutable GET/referrers surface used by the resolver, not a production registry storage implementation',
        'the disposable Kind control plane is single-replica; this gate proves workload ordering, not Kubernetes control-plane HA',
      ]),
    });
    writePrivateReport(reportFile, report);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        fixture: REPORT_SCHEMA,
        reportWritten: true,
        passed: true,
      })}\n`,
    );
  } catch (error) {
    diagnostics();
    throw error;
  } finally {
    for (const value of Object.keys(secrets)) secrets[value] = '';
    registryCredential.authorization = '';
    registryCredential.file = '';
    if (created && process.env.QL3_KEEP_KIND_CLUSTER !== '1') {
      kind(['delete', 'cluster', '--name', clusterName], {
        label: `delete exact Kind cluster ${clusterName}`,
      });
    } else if (created) {
      process.stderr.write(
        `Kept isolated Kind cluster ${clusterName} by explicit request\n`,
      );
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        schema: 'qinglong/plugin-package-recovery-e2e-live-failure@v1',
        name: error?.name ?? 'Error',
        message: error?.message ?? 'unknown failure',
      })}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REPORT_SCHEMA,
  privateReportPath,
  writePrivateReport,
};
