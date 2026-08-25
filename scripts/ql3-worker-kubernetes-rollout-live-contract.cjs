#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHash } = crypto;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createMutualTlsPki } = require('./lib/ql3-live-pki.cjs');
const {
  validateWorkerKubernetesRolloutLiveReport,
} = require('./ql3-worker-kubernetes-rollout-live-audit.cjs');
const {
  remoteWorkerArchitectureForNodeRuntime,
  remoteWorkerSupportTierForArchitecture,
} = require('../packages/ql3-runtime-core/dist/remote-execution/remoteWorkerCompatibility.js');

const ROOT = path.resolve(__dirname, '..');
const K3S_IMAGE = 'rancher/k3s:v1.34.3-k3s1';
const K3S_DIGEST =
  'sha256:71abd3a56f57884c62732e0e0d87606052cb5f8555b7db7e8e33c04570b8175c';
const POSTGRES_IMAGE = 'postgres:18.4-bookworm';
const POSTGRES_DIGEST =
  'sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const POSTGRES_DATABASE = 'ql3_contract';
const POSTGRES_SUPERUSER_PASSWORD = 'postgres';
const POSTGRES_ROLES = Object.freeze({
  migration: Object.freeze({ user: 'ql3_migration', password: 'ql3_migration_test' }),
  runtime: Object.freeze({ user: 'ql3_runtime', password: 'ql3_runtime_test' }),
  admin: Object.freeze({ user: 'ql3_admin', password: 'ql3_admin_test' }),
  automationManager: Object.freeze({
    user: 'ql3_automation_manager',
    password: 'ql3_automation_manager_test',
  }),
  approvalManager: Object.freeze({
    user: 'ql3_approval_manager',
    password: 'ql3_approval_manager_test',
  }),
  packageManager: Object.freeze({
    user: 'ql3_package_manager',
    password: 'ql3_package_manager_test',
  }),
  packageExecutor: Object.freeze({
    user: 'ql3_package_executor',
    password: 'ql3_package_executor_test',
  }),
  workerCredentialManager: Object.freeze({
    user: 'ql3_worker_credential_manager',
    password: 'ql3_worker_credential_manager_test',
  }),
  workerCredentialExecutor: Object.freeze({
    user: 'ql3_worker_credential_executor',
    password: 'ql3_worker_credential_executor_test',
  }),
  workerIngress: Object.freeze({
    user: 'ql3_worker_ingress',
    password: 'ql3_worker_ingress_test',
  }),
});
const WORKER_CREDENTIAL_PEPPER = Buffer.alloc(32, 7).toString('base64url');
const EXECUTOR_NAMESPACE = 'ql3-worker-executor-live';
const EXECUTOR_SERVICE_ACCOUNT = 'ql3-worker-credential-executor-live';
const NAMESPACE = 'ql3-worker-rollout-live';
const STAGE_NAMESPACE = 'ql3-worker-rollout-stage-live';
const DELIVERY_SERVICE_ACCOUNT = 'ql3-worker-credential-admin';
const TOKEN_ISSUER_USER = 'ql3-worker-credential-operator-live';
const DEPLOYMENT = 'ql3-worker-live';
const TARGET_SECRET = 'ql3-worker-live-credential';
const WORKER_ID = 'ql3-worker-live';
const WORKER_INGRESS_SERVICE = 'ql3-worker-ingress';
const WORKER_IMAGE_BASE = 'ql3-worker-product-live';
const CONTROL_IMAGE_BASE = 'ql3-worker-control-live';
const FIXTURE = 'qinglong/worker-kubernetes-rollout-live-contract@v2';
const LIMITATIONS = Object.freeze([
  'single-node K3s local-path PVC is not multi-node CSI detach/attach evidence',
  'the product phase proves Session lifecycle but does not execute a Remote Run; the independent Worker PostgreSQL live gate owns Run execution evidence',
  'forced Pod deletion is not physical node power loss',
  'the live fixture uses deterministic local strong-User principals, not a production external IdP ceremony',
]);
const clusterRequire = createRequire(
  path.join(ROOT, 'packages/ql3-cluster-admin/package.json'),
);

function run(binary, args, options = {}) {
  if (!options.quiet) {
    process.stderr.write(`+ ${path.basename(binary)} ${args.join(' ')}\n`);
  }
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${path.basename(binary)} failed with ${String(result.status)}: ` +
      `${result.stderr || result.stdout || ''}`,
    );
  }
  return {
    status: result.status,
    stdout: options.capture ? result.stdout.trim() : '',
    stderr: options.capture ? result.stderr.trim() : '',
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, inspect) {
  const startedAt = Date.now();
  let last = 'not observed';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await inspect();
      if (value?.ready) return value.value;
      if (value?.fact) last = value.fact;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`${description} timed out: ${last}`);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function privateReportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-worker-kubernetes-rollout-live-contract ' +
        '--report=/absolute/private-report.json',
    );
  }
  const reportFile = argv[0].slice('--report='.length);
  if (fs.existsSync(reportFile)) {
    throw new Error('refusing to overwrite the Worker Kubernetes live report');
  }
  const parent = fs.lstatSync(path.dirname(reportFile));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Worker Kubernetes live report parent must be a real directory');
  }
  return reportFile;
}

function writePrivateReport(reportFile, report) {
  const temporaryReport = path.join(
    path.dirname(reportFile),
    `.${path.basename(reportFile)}.${process.pid}.` +
      `${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryReport, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryReport, reportFile);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryReport, { force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  if (process.env.QL3_WORKER_KUBERNETES_ROLLOUT_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_WORKER_KUBERNETES_ROLLOUT_LIVE=1',
    );
  }
  const docker = process.env.QL3_DOCKER_BIN || 'docker';
  const kubectlBinary = process.env.QL3_KUBECTL_BIN || 'kubectl';
  const container = `ql3-worker-rollout-live-${process.pid.toString(36)}`;
  const postgresContainer =
    `ql3-worker-rollout-postgres-live-${process.pid.toString(36)}`;
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-worker-rollout-live-'),
  );
  const kubeconfig = path.join(temporary, 'kubeconfig');
  const imageArchive = path.join(temporary, 'actor-image.tar');
  const adminImageArchive = path.join(temporary, 'admin-image.tar');
  const adminImage = `ql3-worker-credential-executor-live:${process.pid.toString(36)}`;
  const workerImageArchive = path.join(temporary, 'worker-image.tar');
  const controlImageArchive = path.join(temporary, 'control-image.tar');
  const imageSuffix = process.pid.toString(36);
  const workerImage = `${WORKER_IMAGE_BASE}:${imageSuffix}`;
  const controlImage = `${CONTROL_IMAGE_BASE}:${imageSuffix}`;
  let created = false;
  let postgresCreated = false;
  let adminImageBuilt = false;
  let workerImageBuilt = false;
  let controlImageBuilt = false;
  let migrationDatabase;
  let managerDatabase;
  let first;
  let second;
  try {
    run(docker, ['version'], { capture: true, quiet: true });
    const image = JSON.parse(run(docker, [
      'image', 'inspect', K3S_IMAGE,
    ], { capture: true, quiet: true }).stdout)[0];
    assert.ok(image.RepoDigests.includes(`rancher/k3s@${K3S_DIGEST}`));
    assert.equal(
      run(docker, ['inspect', container], {
        capture: true,
        quiet: true,
        allowFailure: true,
      }).status,
      1,
      'refusing to reuse an existing live-contract container',
    );
    run(docker, [
      'run', '-d', '--privileged', '--name', container,
      '-p', '127.0.0.1::6443',
      K3S_IMAGE,
      'server', '--disable=traefik', '--disable=servicelb',
      '--write-kubeconfig-mode=600', '--tls-san=127.0.0.1',
    ]);
    created = true;
    await waitFor('K3s API readiness', 120_000, () => {
      const result = run(docker, [
        'exec', container, 'kubectl', 'get', '--raw=/readyz',
      ], { capture: true, quiet: true, allowFailure: true });
      return result.status === 0 && result.stdout === 'ok'
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    const port = run(docker, ['port', container, '6443/tcp'], {
      capture: true,
      quiet: true,
    }).stdout;
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    const k3sAddress = run(docker, [
      'inspect', '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      container,
    ], { capture: true, quiet: true }).stdout;
    assert.match(k3sAddress, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    const config = run(docker, [
      'exec', container, 'cat', '/etc/rancher/k3s/k3s.yaml',
    ], { capture: true, quiet: true }).stdout.replace(
      'https://127.0.0.1:6443',
      `https://${port}`,
    );
    fs.writeFileSync(kubeconfig, `${config}\n`, { mode: 0o600, flag: 'wx' });

    run(docker, ['image', 'save', '--output', imageArchive, K3S_IMAGE]);
    run(docker, ['cp', imageArchive, `${container}:/tmp/ql3-worker-actor.tar`]);
    run(docker, [
      'exec', container, 'ctr',
      '--address', '/run/k3s/containerd/containerd.sock',
      '--namespace', 'k8s.io', 'images', 'import',
      '/tmp/ql3-worker-actor.tar',
    ]);
    run(docker, [
      'exec', container, 'rm', '-f', '/tmp/ql3-worker-actor.tar',
    ]);
    fs.unlinkSync(imageArchive);

    const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
      quiet: true,
    }).stdout;
    run(docker, [
      'build',
      '--file', 'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag', adminImage,
      '--build-arg', `SOURCE_REVISION=${sourceRevision}`,
      '.',
    ]);
    adminImageBuilt = true;
    run(docker, ['image', 'save', '--output', adminImageArchive, adminImage]);
    run(docker, [
      'cp', adminImageArchive,
      `${container}:/tmp/ql3-worker-credential-executor.tar`,
    ]);
    run(docker, [
      'exec', container, 'ctr',
      '--address', '/run/k3s/containerd/containerd.sock',
      '--namespace', 'k8s.io', 'images', 'import',
      '/tmp/ql3-worker-credential-executor.tar',
    ]);
    run(docker, [
      'exec', container, 'rm', '-f',
      '/tmp/ql3-worker-credential-executor.tar',
    ]);
    fs.unlinkSync(adminImageArchive);

    for (const imageBuild of [
      {
        dockerfile: 'deploy/containers/ql3-worker/Dockerfile',
        image: workerImage,
        archive: workerImageArchive,
        remote: '/tmp/ql3-worker-product.tar',
        markBuilt() {
          workerImageBuilt = true;
        },
      },
      {
        dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
        image: controlImage,
        archive: controlImageArchive,
        remote: '/tmp/ql3-worker-control.tar',
        markBuilt() {
          controlImageBuilt = true;
        },
      },
    ]) {
      run(docker, [
        'build',
        '--file', imageBuild.dockerfile,
        '--tag', imageBuild.image,
        '--build-arg', `SOURCE_REVISION=${sourceRevision}`,
        '.',
      ]);
      imageBuild.markBuilt();
      run(docker, [
        'image', 'save', '--output', imageBuild.archive, imageBuild.image,
      ]);
      run(docker, ['cp', imageBuild.archive, `${container}:${imageBuild.remote}`]);
      run(docker, [
        'exec', container, 'ctr',
        '--address', '/run/k3s/containerd/containerd.sock',
        '--namespace', 'k8s.io', 'images', 'import', imageBuild.remote,
      ]);
      run(docker, ['exec', container, 'rm', '-f', imageBuild.remote]);
      fs.unlinkSync(imageBuild.archive);
    }

    const kubectl = (args, options = {}) => run(
      kubectlBinary,
      ['--kubeconfig', kubeconfig, ...args],
      options,
    );
    const kubectlJson = (args) => JSON.parse(kubectl([...args, '-o', 'json'], {
      capture: true,
      quiet: true,
    }).stdout);
    const apply = (body) => kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(body)}\n`,
      quiet: true,
    });
    const create = (body) => kubectl(['create', '-f', '-'], {
      input: `${JSON.stringify(body)}\n`,
      quiet: true,
    });

    apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE } });
    apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: STAGE_NAMESPACE },
    });
    apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: EXECUTOR_NAMESPACE },
    });
    apply({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: DELIVERY_SERVICE_ACCOUNT,
        namespace: STAGE_NAMESPACE,
      },
      automountServiceAccountToken: false,
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: {
        name: 'ql3-worker-credential-stage-admin',
        namespace: STAGE_NAMESPACE,
      },
      rules: [{
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get', 'list', 'create', 'delete'],
      }],
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: {
        name: 'ql3-worker-credential-stage-admin',
        namespace: STAGE_NAMESPACE,
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'ql3-worker-credential-stage-admin',
      },
      subjects: [{
        kind: 'ServiceAccount',
        name: DELIVERY_SERVICE_ACCOUNT,
        namespace: STAGE_NAMESPACE,
      }],
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: {
        name: 'ql3-worker-credential-token-issuer',
        namespace: STAGE_NAMESPACE,
      },
      rules: [{
        apiGroups: [''],
        resources: ['serviceaccounts/token'],
        resourceNames: [DELIVERY_SERVICE_ACCOUNT],
        verbs: ['create'],
      }],
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: {
        name: 'ql3-worker-credential-token-issuer',
        namespace: STAGE_NAMESPACE,
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'ql3-worker-credential-token-issuer',
      },
      subjects: [{
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'User',
        name: TOKEN_ISSUER_USER,
      }],
    });
    apply({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: EXECUTOR_SERVICE_ACCOUNT,
        namespace: EXECUTOR_NAMESPACE,
      },
      automountServiceAccountToken: false,
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: {
        name: 'ql3-worker-credential-executor-token-issuer-live',
        namespace: STAGE_NAMESPACE,
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'ql3-worker-credential-token-issuer',
      },
      subjects: [{
        kind: 'ServiceAccount',
        name: EXECUTOR_SERVICE_ACCOUNT,
        namespace: EXECUTOR_NAMESPACE,
      }],
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: {
        name: 'ql3-worker-credential-target-admin',
        namespace: NAMESPACE,
      },
      rules: [
        {
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: [TARGET_SECRET],
          verbs: ['get', 'update'],
        },
        {
          apiGroups: ['apps'],
          resources: ['deployments'],
          resourceNames: [DEPLOYMENT],
          verbs: ['get', 'update'],
        },
      ],
    });
    apply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: {
        name: 'ql3-worker-credential-target-admin',
        namespace: NAMESPACE,
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'ql3-worker-credential-target-admin',
      },
      subjects: [{
        kind: 'ServiceAccount',
        name: DELIVERY_SERVICE_ACCOUNT,
        namespace: STAGE_NAMESPACE,
      }],
    });
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-worker-live-identity', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'ca.crt': 'ca-generation-a',
        'tls.key': 'key-generation-a',
        'tls.crt': 'certificate-generation-a',
      },
    });
    create({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: TARGET_SECRET,
        namespace: NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'qinglong3',
          'qinglong.io/worker-credential-target': 'prepared-v3',
        },
      },
      type: 'Opaque',
      data: {},
    });
    apply({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'ql3-worker-live-state', namespace: NAMESPACE },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '64Mi' } },
      },
    });
    apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: DEPLOYMENT,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/component': 'worker' },
      },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: DEPLOYMENT } },
        template: {
          metadata: {
            labels: {
              app: DEPLOYMENT,
              'app.kubernetes.io/component': 'worker',
            },
            annotations: {
              'qinglong.io/worker-identity-generation': 'identity-a',
            },
          },
          spec: {
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 30,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              fsGroup: 65532,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            initContainers: [{
              name: 'materialize-worker-authority',
              image: K3S_IMAGE,
              imagePullPolicy: 'Never',
              command: ['/bin/sh', '-ec'],
              args: [
                'umask 077; mkdir -p /authority/private /state/journal; ' +
                'cp /projected/ca.crt /authority/private/ca.crt; ' +
                'cp /projected/credential-token /authority/private/credential-token; ' +
                'chmod 0400 /authority/private/ca.crt ' +
                '/authority/private/credential-token',
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'projected-authority', mountPath: '/projected', readOnly: true },
                { name: 'materialized-authority', mountPath: '/authority' },
                { name: 'worker-state', mountPath: '/state' },
              ],
            }],
            containers: [{
              name: 'worker',
              image: K3S_IMAGE,
              imagePullPolicy: 'Never',
              command: ['/bin/sh', '-ec'],
              args: [
                'credential_digest="$(sha256sum /authority/private/credential-token | cut -d" " -f1)"; ' +
                'ca_digest="$(sha256sum /authority/private/ca.crt | cut -d" " -f1)"; ' +
                'printf "start %s %s %s\\n" "$POD_UID" "$credential_digest" "$ca_digest" >> /state/journal/rollout.log; ' +
                'sleep 86400',
              ],
              env: [{
                name: 'POD_UID',
                valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
              }],
              lifecycle: {
                preStop: {
                  exec: {
                    command: ['/bin/sh', '-ec',
                      'printf "stop %s\\n" "$POD_UID" >> /state/journal/rollout.log'],
                  },
                },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'materialized-authority', mountPath: '/authority', readOnly: true },
                { name: 'worker-state', mountPath: '/state' },
              ],
            }],
            volumes: [
              {
                name: 'projected-authority',
                projected: {
                  defaultMode: 288,
                  sources: [
                    {
                      secret: {
                        name: 'ql3-worker-live-identity',
                        items: [{ key: 'ca.crt', path: 'ca.crt' }],
                      },
                    },
                    {
                      secret: {
                        name: TARGET_SECRET,
                        items: [{ key: 'credential-token', path: 'credential-token' }],
                      },
                    },
                  ],
                },
              },
              { name: 'materialized-authority', emptyDir: { medium: 'Memory' } },
              {
                name: 'worker-state',
                persistentVolumeClaim: { claimName: 'ql3-worker-live-state' },
              },
            ],
          },
        },
      },
    });

    const k8sEntry = clusterRequire.resolve('@kubernetes/client-node');
    const k8s = await import(pathToFileURL(k8sEntry).href);
    const kube = new k8s.KubeConfig();
    kube.loadFromFile(kubeconfig);
    const currentCluster = kube.getCurrentCluster();
    const currentUser = kube.getCurrentUser();
    assert.ok(currentCluster);
    assert.ok(currentUser);
    const issuerKube = new k8s.KubeConfig();
    issuerKube.loadFromOptions({
      clusters: [{ ...currentCluster, name: 'ql3-live-issuer' }],
      users: [{
        ...currentUser,
        name: 'ql3-live-issuer',
        impersonateUser: TOKEN_ISSUER_USER,
      }],
      contexts: [{
        name: 'ql3-live-issuer',
        cluster: 'ql3-live-issuer',
        user: 'ql3-live-issuer',
        namespace: STAGE_NAMESPACE,
      }],
      currentContext: 'ql3-live-issuer',
    });
    const {
      createWorkerCredentialKubernetesKubeConfigTokenRequestSession,
    } = clusterRequire(
      '@qinglong/cluster-admin/worker-credential-kubernetes-token-request',
    );
    const {
      workerCredentialKubernetesDeploymentTargetDigest,
    } = clusterRequire(
      '@qinglong/cluster-admin/worker-credential-kubernetes-delivery',
    );
    const {
      createClusterWorkerCredentialManagementService,
    } = clusterRequire(
      '@qinglong/cluster-admin/worker-credential-management',
    );
    const {
      runClusterWorkerCredentialExecution,
    } = clusterRequire(
      '@qinglong/cluster-admin/worker-credential-management-executor',
    );
    const {
      assertPostgresWorkerCredentialManagerSchemaReady,
      createPostgresDatabaseOpener,
    } = clusterRequire(
      '@qinglong/cluster-postgres/worker-credential-manager',
    );
    const { runPostgresMigrations } = clusterRequire(
      '@qinglong/cluster-postgres/migration',
    );
    const deliveryOptions = Object.freeze({
      clusterIdentity: 'ql3-worker-rollout-live',
      namespace: NAMESPACE,
      stageNamespace: STAGE_NAMESPACE,
      targetSecretName: TARGET_SECRET,
      targetDeploymentName: DEPLOYMENT,
      targetDataKey: 'credential-token',
    });
    const deliverySession =
      createWorkerCredentialKubernetesKubeConfigTokenRequestSession(
        issuerKube,
        k8s,
        {
          serviceAccountName: DELIVERY_SERVICE_ACCOUNT,
          identitySecretName: 'ql3-worker-live-identity',
          delivery: deliveryOptions,
        },
      );

    assert.equal(
      run(docker, ['inspect', postgresContainer], {
        capture: true,
        quiet: true,
        allowFailure: true,
      }).status,
      1,
      'refusing to reuse an existing PostgreSQL live-contract container',
    );
    const postgresImage = JSON.parse(run(docker, [
      'image', 'inspect', POSTGRES_IMAGE,
    ], { capture: true, quiet: true }).stdout)[0];
    assert.ok(postgresImage.RepoDigests.includes(`postgres@${POSTGRES_DIGEST}`));
    run(docker, [
      'run', '-d', '--name', postgresContainer,
      '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_DB=${POSTGRES_DATABASE}`,
      '-e', 'POSTGRES_USER=postgres',
      '-e', `POSTGRES_PASSWORD=${POSTGRES_SUPERUSER_PASSWORD}`,
      POSTGRES_IMAGE,
    ]);
    postgresCreated = true;
    await waitFor('PostgreSQL readiness', 60_000, () => {
      const result = run(docker, [
        'exec', postgresContainer, 'pg_isready',
        '-h', '127.0.0.1', '-U', 'postgres', '-d', POSTGRES_DATABASE,
      ], { capture: true, quiet: true, allowFailure: true });
      return result.status === 0
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    const postgresEndpoint = run(docker, [
      'port', postgresContainer, '5432/tcp',
    ], { capture: true, quiet: true }).stdout;
    assert.match(postgresEndpoint, /^127\.0\.0\.1:\d+$/);
    const postgresPort = Number(postgresEndpoint.slice(postgresEndpoint.lastIndexOf(':') + 1));
    const postgresAddress = run(docker, [
      'inspect', '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      postgresContainer,
    ], { capture: true, quiet: true }).stdout;
    assert.match(postgresAddress, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    const databaseUrl = ({ user, password }) =>
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@127.0.0.1:${postgresPort}/${POSTGRES_DATABASE}`;
    const openDatabase = (role, credential, applicationName) =>
      createPostgresDatabaseOpener({
        role,
        connection: {
          connectionString: databaseUrl(credential),
          tls: { mode: 'disable' },
        },
        pool: {
          applicationName,
          maxConnections: role === 'migration' ? 1 : 2,
          connectionTimeoutMs: 2_000,
        },
        onPoolError() {},
      });
    const superuser = Object.freeze({
      user: 'postgres',
      password: POSTGRES_SUPERUSER_PASSWORD,
    });
    const bootstrapDatabase = await openDatabase(
      'migration',
      superuser,
      'ql3-worker-rollout-bootstrap',
    )();
    try {
      for (const credential of Object.values(POSTGRES_ROLES)) {
        await bootstrapDatabase.pool.query(
          `CREATE ROLE ${credential.user} LOGIN PASSWORD '${credential.password}'`,
        );
      }
      await bootstrapDatabase.pool.query(
        `ALTER DATABASE ${POSTGRES_DATABASE} OWNER TO ` +
          POSTGRES_ROLES.migration.user,
      );
    } finally {
      await bootstrapDatabase.close();
    }
    migrationDatabase = await openDatabase(
      'migration',
      POSTGRES_ROLES.migration,
      'ql3-worker-rollout-migration',
    )();
    await runPostgresMigrations({ pool: migrationDatabase.pool });
    const seededAtMs = Date.now();
    await migrationDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'cluster-authority', 'Cluster Authority', 'cluster-authority',
         'active', 1, $1, $1
       )`,
      [seededAtMs],
    );
    for (const [subjectId, mutationId] of [
      ['operator-a', 'binding-operator-a-v1'],
      ['reviewer-b', 'binding-reviewer-b-v1'],
    ]) {
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES (
           'cluster-authority', 'user', $1, 1, 'active', 'admin',
           $2, 'user', 'owner-a', $3
         )`,
        [subjectId, mutationId, seededAtMs],
      );
    }
    managerDatabase = await openDatabase(
      'worker-credential-manager',
      POSTGRES_ROLES.workerCredentialManager,
      'ql3-worker-credential-manager-live',
    )();
    const managerReadiness =
      await assertPostgresWorkerCredentialManagerSchemaReady(
        managerDatabase.pool,
      );
    let managementNowMs = Date.now();
    const management = createClusterWorkerCredentialManagementService({
      pool: managerDatabase.pool,
      now: () => managementNowMs,
    });
    const deploymentTargetDigest =
      workerCredentialKubernetesDeploymentTargetDigest(deliveryOptions);
    const openExecutorDatabase = openDatabase(
      'worker-credential-executor',
      POSTGRES_ROLES.workerCredentialExecutor,
      'ql3-worker-credential-executor-live',
    );
    let tokenRequestEvidence;
    let tokenRequestSessions = 0;
    let authorizationRechecks = 0;
    const approve = async ({
      generation,
      deliveryId,
      credentialId,
      previousCredentialId,
      auditIds,
    }) => {
      const plannedAtMs = Date.now();
      managementNowMs = plannedAtMs;
      const requester = Object.freeze({
        subject: Object.freeze({ type: 'user', id: 'operator-a' }),
        authenticationId: `session-operator-a-${generation}`,
        authenticatedAtMs: plannedAtMs - 100,
        expiresAtMs: plannedAtMs + 30 * 60_000,
        assurance: 'multi_factor',
      });
      const reviewer = Object.freeze({
        subject: Object.freeze({ type: 'user', id: 'reviewer-b' }),
        authenticationId: `session-reviewer-b-${generation}`,
        authenticatedAtMs: plannedAtMs - 100,
        expiresAtMs: plannedAtMs + 30 * 60_000,
        assurance: 'hardware',
      });
      const actionRef = `worker-credential:ql3-worker-live:${generation}`;
      const planned = await management.plan({
        actionRef,
        authorityProjectId: 'cluster-authority',
        action: previousCredentialId === null ? 'issue' : 'rotate',
        deliveryId,
        workerId: 'ql3-worker-live',
        credentialId,
        previousCredentialId,
        credentialNotBeforeAtMs: plannedAtMs,
        credentialExpiresAtMs: plannedAtMs + 60 * 60_000,
        deploymentTargetDigest,
        deploymentGeneration: generation,
        principal: requester,
      });
      managementNowMs = plannedAtMs + 1;
      const proposed = await management.propose({
        actionRef,
        authorityProjectId: 'cluster-authority',
        approvalRequestId: `approval-${generation}`,
        approvalAuditEventId: auditIds.proposal,
        principal: requester,
      });
      managementNowMs = plannedAtMs + 2;
      const decided = await management.decide({
        actionRef,
        authorityProjectId: 'cluster-authority',
        approvalRequestId: proposed.approvalRequest.id,
        expectedVersion: 1,
        decisionId: `decision-${generation}`,
        auditEventId: auditIds.decision,
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: reviewer,
      });
      const executionNowMs = plannedAtMs + 3;
      assert.equal(planned.status, 'created');
      assert.equal(proposed.approvalStatus, 'created');
      assert.equal(decided.status, 'decided');
      assert.equal(decided.request.state, 'approved');
      return Object.freeze({
        planned,
        proposed,
        decided,
        executionNowMs,
        command: Object.freeze({
          schemaVersion: 1,
          actionRef,
          approvalRequestId: proposed.approvalRequest.id,
          consumptionId: `consumption-${generation}`,
          dispatchId: `dispatch-${generation}`,
          auditEventId: auditIds.consume,
        }),
      });
    };
    const approveAndExecute = async (parameters) => {
      const approval = await approve(parameters);
      const executionOptions = {
        openDatabase: openExecutorDatabase,
        tokenRequestSession: deliverySession,
        workerCredentialPepper: WORKER_CREDENTIAL_PEPPER,
        actionRef: approval.command.actionRef,
        approvalRequestId: approval.command.approvalRequestId,
        consumptionId: approval.command.consumptionId,
        dispatchId: approval.command.dispatchId,
        auditEventId: approval.command.auditEventId,
        confirmAuthorization() {
          authorizationRechecks += 1;
        },
        now: () => approval.executionNowMs,
      };
      const executed = await runClusterWorkerCredentialExecution(
        executionOptions,
      );
      tokenRequestSessions += 1;
      if (tokenRequestEvidence === undefined) {
        tokenRequestEvidence = executed.tokenRequest;
      } else {
        assert.deepEqual(executed.tokenRequest, tokenRequestEvidence);
      }
      assert.equal(executed.execution.status, 'succeeded');
      assert.equal(executed.result.status, 'published');
      assert.ok(executed.result.delivery);
      assert.equal(
        executed.result.delivery.deploymentTargetDigest,
        deploymentTargetDigest,
      );
      const replayed = await runClusterWorkerCredentialExecution(
        executionOptions,
      );
      assert.equal(replayed.result.status, 'existing');
      assert.equal(replayed.tokenRequest, null);
      assert.deepEqual(replayed.execution, executed.execution);
      assert.deepEqual(replayed.result.delivery, executed.result.delivery);
      return Object.freeze({
        candidate: executed.result.delivery,
        publication: Object.freeze({
          publicationDigest: executed.result.delivery.publicationDigest,
        }),
        planDigest: approval.planned.plan.planDigest,
        approvalRequestId: approval.proposed.approvalRequest.id,
        dispatchId: executed.approval.id,
        executorDatabase: executed.database,
      });
    };
    const currentPod = async (excludedUid = null) => waitFor(
      'Worker replacement Pod',
      120_000,
      () => {
        const pods = kubectlJson([
          '-n', NAMESPACE, 'get', 'pods', '-l', `app=${DEPLOYMENT}`,
        ]).items.filter((pod) =>
          pod.metadata.deletionTimestamp === undefined &&
          pod.status.phase === 'Running' &&
          pod.metadata.uid !== excludedUid);
        return pods.length === 1
          ? { ready: true, value: pods[0] }
          : { ready: false, fact: `${pods.length} running replacement Pods` };
      },
    );
    const journal = (pod) => kubectl([
      '-n', NAMESPACE, 'exec', pod.metadata.name, '-c', 'worker', '--',
      'cat', '/state/journal/rollout.log',
    ], { capture: true, quiet: true }).stdout.split('\n').filter(Boolean);

    const apiServiceAddress = kubectlJson([
      '-n', 'default', 'get', 'service', 'kubernetes',
    ]).spec.clusterIP;
    assert.match(apiServiceAddress, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    await waitFor('executor namespace root CA projection', 30_000, () => {
      const result = kubectl([
        '-n', EXECUTOR_NAMESPACE, 'get', 'configmap', 'kube-root-ca.crt',
      ], { capture: true, quiet: true, allowFailure: true });
      return result.status === 0
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-worker-credential-executor-pepper-live',
        namespace: EXECUTOR_NAMESPACE,
      },
      type: 'Opaque',
      stringData: {
        'worker-credential-pepper': WORKER_CREDENTIAL_PEPPER,
      },
    });
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-worker-credential-executor-database-live',
        namespace: EXECUTOR_NAMESPACE,
      },
      type: 'Opaque',
      stringData: {
        username: POSTGRES_ROLES.workerCredentialExecutor.user,
        password: POSTGRES_ROLES.workerCredentialExecutor.password,
      },
    });
    apply({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'ql3-worker-credential-executor-live',
        namespace: EXECUTOR_NAMESPACE,
      },
      spec: {
        podSelector: {
          matchLabels: {
            app: 'ql3-worker-credential-executor-live',
          },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [],
        egress: [
          {
            to: [{ ipBlock: { cidr: `${apiServiceAddress}/32` } }],
            ports: [{ protocol: 'TCP', port: 443 }],
          },
          {
            to: [{ ipBlock: { cidr: `${k3sAddress}/32` } }],
            ports: [{ protocol: 'TCP', port: 6443 }],
          },
          {
            to: [{ ipBlock: { cidr: `${postgresAddress}/32` } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
        ],
      },
    });
    const runExecutorJob = async ({ jobName, command, expected }) => {
      const commandConfigName = `${jobName}-command`;
      create({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: commandConfigName,
          namespace: EXECUTOR_NAMESPACE,
        },
        immutable: true,
        data: { 'command.json': JSON.stringify(command) },
      });
      create({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace: EXECUTOR_NAMESPACE,
          labels: {
            app: 'ql3-worker-credential-executor-live',
            'qinglong.io/execution-model': 'caller-driven',
          },
        },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 600,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                app: 'ql3-worker-credential-executor-live',
                'qinglong.io/execution-model': 'caller-driven',
              },
            },
            spec: {
              serviceAccountName: EXECUTOR_SERVICE_ACCOUNT,
              automountServiceAccountToken: false,
              restartPolicy: 'Never',
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [{
                name: 'executor',
                image: adminImage,
                imagePullPolicy: 'Never',
                command: ['/bin/sh', '-c'],
                args: [
                  'set +e\n' +
                  'output="$(node ' +
                  '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/' +
                  'worker-credential/workerCredentialExecutorCli.js 2>&1)"\n' +
                  'status=$?\n' +
                  'printf \'%s\\n\' "$output" > /dev/termination-log\n' +
                  'printf \'%s\\n\' "$output"\n' +
                  'exit "$status"',
                ],
                terminationMessagePolicy: 'File',
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                env: [
                  { name: 'QL3_PROFILE', value: 'cluster-admin' },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED',
                    value: 'true',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_COMMAND_FILE',
                    value: '/var/run/qinglong3/command/command.json',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_PEPPER_FILE',
                    value: '/var/run/secrets/qinglong3/executor/pepper',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_CLUSTER_IDENTITY',
                    value: 'ql3-worker-rollout-live',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_STAGE_NAMESPACE',
                    value: STAGE_NAMESPACE,
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_NAMESPACE',
                    value: NAMESPACE,
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_SECRET',
                    value: TARGET_SECRET,
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DEPLOYMENT',
                    value: DEPLOYMENT,
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DATA_KEY',
                    value: 'credential-token',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_DELIVERY_SERVICE_ACCOUNT',
                    value: DELIVERY_SERVICE_ACCOUNT,
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_EXECUTOR_IDENTITY_SECRET',
                    value: 'ql3-worker-live-identity',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_HOST',
                    value: postgresAddress,
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_PORT',
                    value: '5432',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_DATABASE',
                    value: POSTGRES_DATABASE,
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_USER',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'ql3-worker-credential-executor-database-live',
                        key: 'username',
                      },
                    },
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'ql3-worker-credential-executor-database-live',
                        key: 'password',
                      },
                    },
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_MODE',
                    value: 'disable',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_ALLOW_INSECURE',
                    value: 'true',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_APPLICATION_NAME',
                    value: 'ql3-worker-credential-executor-job-live',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_MAX_CONNECTIONS',
                    value: '1',
                  },
                ],
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '500m', memory: '256Mi' },
                },
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  {
                    name: 'kube-api-access',
                    mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
                    readOnly: true,
                  },
                  {
                    name: 'command',
                    mountPath: '/var/run/qinglong3/command',
                    readOnly: true,
                  },
                  {
                    name: 'pepper',
                    mountPath: '/var/run/secrets/qinglong3/executor',
                    readOnly: true,
                  },
                ],
              }],
              volumes: [
                { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } },
                {
                  name: 'kube-api-access',
                  projected: {
                    defaultMode: 288,
                    sources: [
                      {
                        serviceAccountToken: {
                          path: 'token',
                          expirationSeconds: 600,
                        },
                      },
                      {
                        configMap: {
                          name: 'kube-root-ca.crt',
                          items: [{ key: 'ca.crt', path: 'ca.crt' }],
                        },
                      },
                      {
                        downwardAPI: {
                          items: [{
                            path: 'namespace',
                            fieldRef: {
                              apiVersion: 'v1',
                              fieldPath: 'metadata.namespace',
                            },
                          }],
                        },
                      },
                    ],
                  },
                },
                {
                  name: 'command',
                  configMap: {
                    name: commandConfigName,
                    defaultMode: 292,
                    items: [{ key: 'command.json', path: 'command.json' }],
                  },
                },
                {
                  name: 'pepper',
                  secret: {
                    secretName: 'ql3-worker-credential-executor-pepper-live',
                    defaultMode: 288,
                    items: [{
                      key: 'worker-credential-pepper',
                      path: 'pepper',
                    }],
                  },
                },
              ],
            },
          },
        },
      });
      const completion = await waitFor(`${jobName} completion`, 120_000, () => {
        const job = kubectlJson([
          '-n', EXECUTOR_NAMESPACE, 'get', 'job', jobName,
        ]);
        const completed = job.status.conditions?.some(
          (condition) => condition.type === 'Complete' && condition.status === 'True',
        );
        const failed = job.status.conditions?.some(
          (condition) => condition.type === 'Failed' && condition.status === 'True',
        );
        return completed || failed
          ? { ready: true, value: { job, failed } }
          : {
              ready: false,
              fact: `active=${job.status.active ?? 0} failed=${job.status.failed ?? 0}`,
            };
      });
      const pods = kubectlJson([
        '-n', EXECUTOR_NAMESPACE, 'get', 'pods', '-l', `job-name=${jobName}`,
      ]).items;
      assert.equal(pods.length, 1);
      const executorPod = pods[0];
      const terminated = executorPod.status.containerStatuses?.[0]
        ?.state?.terminated;
      const terminationOutput = terminated?.message ?? '';
      if (completion.failed) {
        throw new Error(
          `${jobName} failed (${terminated?.reason ?? 'unknown'}; ` +
          `exit=${terminated?.exitCode ?? 'unknown'}): ` +
          `${terminationOutput || 'no termination output'}`,
        );
      }
      assert.equal(terminated?.exitCode, 0);
      assert.equal(terminationOutput.includes(WORKER_CREDENTIAL_PEPPER), false);
      assert.equal(
        terminationOutput.includes(
          POSTGRES_ROLES.workerCredentialExecutor.password,
        ),
        false,
      );
      const output = JSON.parse(
        terminationOutput.split('\n').filter(Boolean).at(-1),
      );
      assert.deepEqual(output, {
        schemaVersion: 1,
        component: 'qinglong3-worker-credential-executor',
        event: 'execution_completed',
        actionRef: command.actionRef,
        dispatchId: command.dispatchId,
        executionStatus: 'succeeded',
        deliveryStatus: expected.deliveryStatus,
        tokenRequestUsed: expected.tokenRequestUsed,
      });
      const tokenProjection = executorPod.spec.volumes
        .find((volume) => volume.name === 'kube-api-access')
        ?.projected?.sources?.find((source) => source.serviceAccountToken)
        ?.serviceAccountToken;
      assert.equal(executorPod.spec.serviceAccountName, EXECUTOR_SERVICE_ACCOUNT);
      assert.equal(executorPod.spec.automountServiceAccountToken, false);
      assert.equal(tokenProjection?.expirationSeconds, 600);
      return Object.freeze({
        jobName,
        podUid: executorPod.metadata.uid,
        image: executorPod.spec.containers[0].image,
        output: Object.freeze(output),
        projectedIssuerTokenSeconds: tokenProjection.expirationSeconds,
      });
    };

    first = await approveAndExecute({
      generation: 'generation-live_generation_1',
      deliveryId: '323e4567-e89b-42d3-a456-426614174901',
      credentialId: 'live_generation_1',
      previousCredentialId: null,
      auditIds: {
        proposal: '423e4567-e89b-42d3-a456-426614174901',
        decision: '423e4567-e89b-42d3-a456-426614174902',
        consume: '423e4567-e89b-42d3-a456-426614174903',
      },
    });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=120s',
    ], { capture: true, quiet: true });
    const podA = await currentPod();
    await waitFor('first PVC journal record', 30_000, () => {
      const lines = journal(podA);
      return lines.some((line) => line.startsWith(`start ${podA.metadata.uid} `))
        ? { ready: true, value: lines }
        : { ready: false, fact: JSON.stringify(lines) };
    });

    second = await approveAndExecute({
      generation: 'generation-live_generation_2',
      deliveryId: '323e4567-e89b-42d3-a456-426614174902',
      credentialId: 'live_generation_2',
      previousCredentialId: 'live_generation_1',
      auditIds: {
        proposal: '523e4567-e89b-42d3-a456-426614174901',
        decision: '523e4567-e89b-42d3-a456-426614174902',
        consume: '523e4567-e89b-42d3-a456-426614174903',
      },
    });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=120s',
    ], { capture: true, quiet: true });
    const podB = await currentPod(podA.metadata.uid);
    const afterCredentialRollout = await waitFor(
      'credential rollout journal convergence',
      30_000,
      () => {
        const lines = journal(podB);
        const stopped = lines.indexOf(`stop ${podA.metadata.uid}`);
        const started = lines.findIndex((line) =>
          line.startsWith(`start ${podB.metadata.uid} `));
        return stopped >= 0 && started > stopped
          ? { ready: true, value: lines }
          : { ready: false, fact: JSON.stringify(lines) };
      },
    );

    kubectl([
      '-n', NAMESPACE, 'delete', 'pod', podB.metadata.name,
      '--grace-period=0', '--force', '--wait=true',
    ], { capture: true, quiet: true });
    const podAfterCrash = await currentPod(podB.metadata.uid);
    const afterCrash = await waitFor('forced Pod replacement PVC recovery', 30_000, () => {
      const lines = journal(podAfterCrash);
      return lines.some((line) =>
        line.startsWith(`start ${podAfterCrash.metadata.uid} `)) &&
        lines.some((line) => line.startsWith(`start ${podA.metadata.uid} `))
        ? { ready: true, value: lines }
        : { ready: false, fact: JSON.stringify(lines) };
    });

    const thirdApproval = await approve({
      generation: 'generation-live_generation_3',
      deliveryId: '323e4567-e89b-42d3-a456-426614174903',
      credentialId: 'live_generation_3',
      previousCredentialId: 'live_generation_2',
      auditIds: {
        proposal: '623e4567-e89b-42d3-a456-426614174901',
        decision: '623e4567-e89b-42d3-a456-426614174902',
        consume: '623e4567-e89b-42d3-a456-426614174903',
      },
    });
    const executorJob = await runExecutorJob({
      jobName: 'ql3-worker-credential-executor-live-3',
      command: thirdApproval.command,
      expected: { deliveryStatus: 'published', tokenRequestUsed: true },
    });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=120s',
    ], { capture: true, quiet: true });
    const podAfterExecutorJob = await currentPod(podAfterCrash.metadata.uid);
    const afterExecutorJobRollout = await waitFor(
      'executor Job credential rollout journal convergence',
      30_000,
      () => {
        const lines = journal(podAfterExecutorJob);
        const stopped = lines.indexOf(`stop ${podAfterCrash.metadata.uid}`);
        const started = lines.findIndex((line) =>
          line.startsWith(`start ${podAfterExecutorJob.metadata.uid} `));
        return stopped >= 0 && started > stopped
          ? { ready: true, value: lines }
          : { ready: false, fact: JSON.stringify(lines) };
      },
    );
    const executorReplayJob = await runExecutorJob({
      jobName: 'ql3-worker-credential-executor-live-3-replay',
      command: thirdApproval.command,
      expected: { deliveryStatus: 'existing', tokenRequestUsed: false },
    });
    const targetAfterExecutorJob = kubectlJson([
      '-n', NAMESPACE, 'get', 'secret', TARGET_SECRET,
    ]);
    const deploymentAfterExecutorJob = kubectlJson([
      '-n', NAMESPACE, 'get', 'deployment', DEPLOYMENT,
    ]);
    const rolloutAnnotations =
      deploymentAfterExecutorJob.spec.template.metadata.annotations;
    const executorPublication = Object.freeze({
      deliveryId: targetAfterExecutorJob.metadata.annotations[
        'qinglong.io/worker-credential-delivery-id'
      ],
      generation: targetAfterExecutorJob.metadata.annotations[
        'qinglong.io/worker-credential-generation'
      ],
      credentialId: rolloutAnnotations[
        'qinglong.io/worker-credential-id'
      ],
      publicationDigest: rolloutAnnotations[
        'qinglong.io/worker-credential-publication-digest'
      ],
    });
    assert.equal(
      rolloutAnnotations['qinglong.io/worker-credential-delivery-id'],
      executorPublication.deliveryId,
    );
    assert.equal(
      rolloutAnnotations['qinglong.io/worker-credential-generation'],
      executorPublication.generation,
    );
    assert.deepEqual(executorPublication, {
      deliveryId: '323e4567-e89b-42d3-a456-426614174903',
      generation: 'generation-live_generation_3',
      credentialId: 'live_generation_3',
      publicationDigest: executorPublication.publicationDigest,
    });
    assert.match(executorPublication.publicationDigest, /^[a-f0-9]{64}$/);

    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-worker-live-identity', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'ca.crt': 'ca-generation-b',
        'tls.key': 'key-generation-b',
        'tls.crt': 'certificate-generation-b',
      },
    });
    kubectl([
      '-n', NAMESPACE, 'patch', 'deployment', DEPLOYMENT, '--type=merge',
      '-p', JSON.stringify({
        spec: { template: { metadata: { annotations: {
          'qinglong.io/worker-identity-generation': 'identity-b',
        } } } },
      }),
    ], { capture: true, quiet: true });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=120s',
    ], { capture: true, quiet: true });
    const podAfterIdentity = await currentPod(podAfterExecutorJob.metadata.uid);
    const finalJournal = await waitFor('identity rollout journal convergence', 30_000, () => {
      const lines = journal(podAfterIdentity);
      const expectedCaDigest = sha256('ca-generation-b');
      return lines.some((line) =>
        line.startsWith(`start ${podAfterIdentity.metadata.uid} `) &&
        line.endsWith(` ${expectedCaDigest}`))
        ? { ready: true, value: lines }
        : { ready: false, fact: JSON.stringify(lines) };
    });

    // The earlier bounded actor proves Kubernetes publication/PVC mechanics.
    // This second phase deliberately replaces it with the production control
    // and Worker images so Session reconciliation and drain are observed in
    // the same real Deployment/PVC/credential authority.
    const pkiDirectory = path.join(temporary, 'product-pki');
    fs.mkdirSync(pkiDirectory, { mode: 0o700 });
    const ingressServername =
      `${WORKER_INGRESS_SERVICE}.${NAMESPACE}.svc`;
    const pki = createMutualTlsPki({
      directory: pkiDirectory,
      servername: ingressServername,
      label: 'QingLong Worker product live',
      run,
      crypto,
    });
    const pkiMaterial = pki.read();
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-worker-ingress-tls-live', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'tls.key': pkiMaterial.serverKey,
        'tls.crt': pkiMaterial.serverCertificate,
        'client-ca.crt': pkiMaterial.ca,
      },
    });
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-worker-live-identity', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'ca.crt': pkiMaterial.ca,
        'tls.key': pkiMaterial.oldClientKey,
        'tls.crt': pkiMaterial.oldClientCertificate,
      },
    });
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-worker-control-live-runtime',
        namespace: NAMESPACE,
      },
      type: 'Opaque',
      stringData: {
        'api-credential-pepper-keyring.json': `${JSON.stringify({
          schemaVersion: 1,
          activePepperKeyId: 'legacy-v1',
          keys: [{
            pepperKeyId: 'legacy-v1',
            pepper: Buffer.alloc(32, 29).toString('base64url'),
          }],
        })}\n`,
      },
    });
    const workerArchitecture = remoteWorkerArchitectureForNodeRuntime(
      process.arch, process.config.variables.arm_version,
    );
    apply({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'ql3-worker-product-config-live', namespace: NAMESPACE },
      data: {
        'worker-id': WORKER_ID,
        'control-origin': `https://${ingressServername}:5801`,
        'capabilities.json': `${JSON.stringify({
          architecture: workerArchitecture,
          operatingSystem: 'linux',
          executors: ['remote-worker'],
          protocolVersion: '1.0.0',
          supportTier:
            remoteWorkerSupportTierForArchitecture(workerArchitecture),
          runtimes: [{ name: 'node', version: '24.18.0' }],
          labels: { contract: 'kubernetes-product-live' },
          capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
          features: [],
        })}\n`,
      },
    });
    apply({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: WORKER_INGRESS_SERVICE, namespace: NAMESPACE },
      spec: {
        selector: { app: 'ql3-worker-control-live' },
        ports: [
          { name: 'http', port: 5800, targetPort: 5800 },
          { name: 'worker-mtls', port: 5801, targetPort: 5801 },
        ],
      },
    });
    const runtimeDatabaseUrl =
      `postgresql://${POSTGRES_ROLES.runtime.user}:` +
      `${POSTGRES_ROLES.runtime.password}@${postgresAddress}:5432/` +
      POSTGRES_DATABASE;
    const ingressDatabaseUrl =
      `postgresql://${POSTGRES_ROLES.workerIngress.user}:` +
      `${POSTGRES_ROLES.workerIngress.password}@${postgresAddress}:5432/` +
      POSTGRES_DATABASE;
    apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'ql3-worker-control-live', namespace: NAMESPACE },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'ql3-worker-control-live' } },
        template: {
          metadata: { labels: { app: 'ql3-worker-control-live' } },
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              fsGroup: 65532,
              fsGroupChangePolicy: 'OnRootMismatch',
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [{
              name: 'control',
              image: controlImage,
              imagePullPolicy: 'Never',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              env: [
                { name: 'QL_DEPLOYMENT_PROFILE', value: 'cluster-control' },
                { name: 'QL3_CLUSTER_CONTROL_ENABLED', value: 'true' },
                { name: 'QL3_CLUSTER_REPLICA_ID', value: 'worker-product-live-control' },
                { name: 'QL3_CLUSTER_HTTP_HOST', value: '0.0.0.0' },
                { name: 'QL3_CLUSTER_HTTP_PORT', value: '5800' },
                { name: 'QL3_POSTGRES_RUNTIME_URL', value: runtimeDatabaseUrl },
                { name: 'QL3_POSTGRES_TLS_MODE', value: 'disable' },
                { name: 'QL3_POSTGRES_ALLOW_INSECURE', value: 'true' },
                { name: 'QL3_POSTGRES_MAX_CONNECTIONS', value: '2' },
                {
                  name: 'QL3_API_CREDENTIAL_PEPPER_KEYRING_FILE',
                  value: '/var/run/secrets/qinglong3/api-credential/keyring.json',
                },
                { name: 'QL3_WORKER_INGRESS_ENABLED', value: 'true' },
                { name: 'QL3_WORKER_INGRESS_HOST', value: '0.0.0.0' },
                { name: 'QL3_WORKER_INGRESS_PORT', value: '5801' },
                { name: 'QL3_POSTGRES_WORKER_INGRESS_URL', value: ingressDatabaseUrl },
                { name: 'QL3_WORKER_INGRESS_POSTGRES_TLS_MODE', value: 'disable' },
                { name: 'QL3_WORKER_INGRESS_POSTGRES_ALLOW_INSECURE', value: 'true' },
                { name: 'QL3_WORKER_INGRESS_POSTGRES_MAX_CONNECTIONS', value: '2' },
                { name: 'QL3_WORKER_CREDENTIAL_PEPPER', value: WORKER_CREDENTIAL_PEPPER },
                { name: 'QL3_WORKER_ARTIFACT_S3_BUCKET', value: 'ql3-worker-product-live' },
                { name: 'QL3_WORKER_ARTIFACT_S3_REGION', value: 'us-east-1' },
                { name: 'AWS_ACCESS_KEY_ID', value: 'ql3-live-access' },
                { name: 'AWS_SECRET_ACCESS_KEY', value: 'ql3-live-secret' },
                {
                  name: 'QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE',
                  value: '/tls/tls.key',
                },
                {
                  name: 'QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE',
                  value: '/tls/tls.crt',
                },
                {
                  name: 'QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE',
                  value: '/tls/client-ca.crt',
                },
              ],
              ports: [
                { name: 'http', containerPort: 5800 },
                { name: 'worker-mtls', containerPort: 5801 },
              ],
              readinessProbe: {
                httpGet: { path: '/readyz', port: 'http' },
                periodSeconds: 2,
                timeoutSeconds: 1,
                failureThreshold: 20,
              },
              volumeMounts: [
                { name: 'tls', mountPath: '/tls', readOnly: true },
                {
                  name: 'api-credential-keyring',
                  mountPath: '/var/run/secrets/qinglong3/api-credential',
                  readOnly: true,
                },
              ],
            }],
            volumes: [
              {
                name: 'tls',
                secret: {
                  secretName: 'ql3-worker-ingress-tls-live',
                  defaultMode: 288,
                },
              },
              {
                name: 'api-credential-keyring',
                secret: {
                  secretName: 'ql3-worker-control-live-runtime',
                  defaultMode: 288,
                  items: [{
                    key: 'api-credential-pepper-keyring.json',
                    path: 'keyring.json',
                  }],
                },
              },
            ],
          },
        },
      },
    });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status',
      'deployment/ql3-worker-control-live', '--timeout=180s',
    ], { capture: true, quiet: true });

    await migrationDatabase.pool.query(`
      CREATE TABLE public.ql3_worker_session_live_observations (
        observation_id bigserial PRIMARY KEY,
        session_id varchar(36) NOT NULL,
        generation integer NOT NULL,
        status varchar(16) NOT NULL,
        version integer NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE FUNCTION public.ql3_capture_worker_session_live_observation()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public AS $capture$
      BEGIN
        IF NEW.worker_id = '${WORKER_ID}' THEN
          INSERT INTO public.ql3_worker_session_live_observations (
            session_id, generation, status, version
          ) VALUES (NEW.session_id, NEW.generation, NEW.status, NEW.version);
        END IF;
        RETURN NEW;
      END;
      $capture$;
      CREATE TRIGGER ql3_capture_worker_session_live_observation
      AFTER INSERT OR UPDATE ON "ql3"."worker_sessions"
      FOR EACH ROW EXECUTE FUNCTION
        public.ql3_capture_worker_session_live_observation();
    `);
    const session = async () => (await migrationDatabase.pool.query(
      `SELECT session_id AS "sessionId", generation, status, version,
              max_concurrent_runs AS "maxConcurrentRuns"
         FROM "ql3"."worker_sessions" WHERE worker_id = $1`,
      [WORKER_ID],
    )).rows[0] ?? null;
    const observations = async () => (await migrationDatabase.pool.query(
      `SELECT session_id AS "sessionId", generation, status, version
         FROM public.ql3_worker_session_live_observations
        ORDER BY observation_id`,
    )).rows;
    const heartbeatAuditCount = async () => Number((
      await migrationDatabase.pool.query(
        `SELECT count(*)::integer AS count
           FROM "ql3"."security_audit_events"
          WHERE subject_type = 'worker' AND subject_id = $1
            AND operation_id = 'worker.heartbeat'`,
        [WORKER_ID],
      )
    ).rows[0].count);
    const waitForOnlineSession = async (excludedSessionId = null) =>
      (await waitFor('production Worker online Session', 180_000, async () => {
        const current = await session();
        return current?.status === 'online' &&
          current.sessionId !== excludedSessionId
          ? { ready: true, value: current }
          : { ready: false, fact: JSON.stringify(current) };
      }));
    const waitForHeartbeatAudit = async (minimumCount) =>
      waitFor('production Worker heartbeat audit', 30_000, async () => {
        const current = await heartbeatAuditCount();
        return current >= minimumCount
          ? { ready: true, value: current }
          : { ready: false, fact: String(current) };
      });
    const productEvents = (pod) => {
      const containerId = pod.status.containerStatuses
        ?.find((status) => status.name === 'worker')
        ?.containerID?.replace(/^containerd:\/\//, '');
      assert.match(containerId ?? '', /^[a-f0-9]{64}$/);
      return run(docker, [
        'exec', container, 'crictl', 'logs', containerId,
      ], { capture: true, quiet: true }).stdout.split('\n').filter(Boolean)
        .map((line) => JSON.parse(line));
    };

    const productAnnotations = {
      ...kubectlJson([
        '-n', NAMESPACE, 'get', 'deployment', DEPLOYMENT,
      ]).spec.template.metadata.annotations,
      'qinglong.io/worker-identity-generation': 'product-identity-a',
    };
    apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: DEPLOYMENT,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/component': 'worker' },
      },
      spec: {
        replicas: 1,
        minReadySeconds: 0,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: DEPLOYMENT } },
        template: {
          metadata: {
            labels: { app: DEPLOYMENT, 'app.kubernetes.io/component': 'worker' },
            annotations: productAnnotations,
          },
          spec: {
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 360,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              fsGroup: 65532,
              fsGroupChangePolicy: 'OnRootMismatch',
              seccompProfile: { type: 'RuntimeDefault' },
            },
            initContainers: [{
              name: 'materialize-worker-authority',
              image: workerImage,
              imagePullPolicy: 'Never',
              command: ['/bin/sh', '-ec'],
              args: [
                'umask 077; mkdir -p /authority/private /state/journal ' +
                '/state/logs /state/receipts /state/identity; ' +
                'chmod 0700 /authority/private /state/journal /state/logs ' +
                '/state/receipts /state/identity; ' +
                'cp /projected/ca.crt /authority/private/ca.crt; ' +
                'cp /projected/tls.key /authority/private/tls.key; ' +
                'cp /projected/tls.crt /authority/private/tls.crt; ' +
                'cp /projected/credential-token /authority/private/credential-token; ' +
                'cp /projected/capabilities.json /authority/private/capabilities.json; ' +
                'chmod 0400 /authority/private/*',
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'projected-authority', mountPath: '/projected', readOnly: true },
                { name: 'materialized-authority', mountPath: '/authority' },
                { name: 'worker-state', mountPath: '/state' },
              ],
            }],
            containers: [{
              name: 'worker',
              image: workerImage,
              imagePullPolicy: 'Never',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              env: [
                { name: 'QL_DEPLOYMENT_PROFILE', value: 'worker' },
                { name: 'QL3_WORKER_RUNTIME_ENABLED', value: 'true' },
                { name: 'QL3_WORKER_ID', value: WORKER_ID },
                {
                  name: 'QL3_WORKER_CONTROL_ORIGIN',
                  value: `https://${ingressServername}:5801`,
                },
                { name: 'QL3_WORKER_CAPACITY_PROFILE', value: 'edge' },
                { name: 'QL3_WORKER_CAPABILITIES_FILE', value: '/authority/private/capabilities.json' },
                { name: 'QL3_WORKER_JOURNAL_ROOT', value: '/state/journal' },
                { name: 'QL3_WORKER_LOG_ROOT', value: '/state/logs' },
                { name: 'QL3_WORKER_RECEIPT_ROOT', value: '/state/receipts' },
                { name: 'QL3_WORKER_CERTIFICATE_STORE_ROOT', value: '/state/identity' },
                { name: 'QL3_WORKER_TRUST_ANCHOR_FILE', value: '/authority/private/ca.crt' },
                { name: 'QL3_WORKER_CREDENTIAL_TOKEN_FILE', value: '/authority/private/credential-token' },
                { name: 'QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE', value: '/authority/private/tls.key' },
                { name: 'QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE', value: '/authority/private/tls.crt' },
                { name: 'QL3_WORKER_CADENCE_MS', value: '100' },
                { name: 'QL3_WORKER_HEARTBEAT_INTERVAL_MS', value: '5000' },
                { name: 'QL3_WORKER_SESSION_LEASE_DURATION_MS', value: '15000' },
                { name: 'QL3_WORKER_DRAIN_TIMEOUT_MS', value: '5000' },
                { name: 'QL3_WORKER_DRAIN_POLL_MS', value: '25' },
              ],
              volumeMounts: [
                { name: 'materialized-authority', mountPath: '/authority', readOnly: true },
                { name: 'worker-state', mountPath: '/state' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            }],
            volumes: [
              {
                name: 'projected-authority',
                projected: {
                  defaultMode: 288,
                  sources: [
                    {
                      secret: {
                        name: 'ql3-worker-live-identity',
                        items: [
                          { key: 'ca.crt', path: 'ca.crt' },
                          { key: 'tls.key', path: 'tls.key' },
                          { key: 'tls.crt', path: 'tls.crt' },
                        ],
                      },
                    },
                    {
                      secret: {
                        name: TARGET_SECRET,
                        items: [{ key: 'credential-token', path: 'credential-token' }],
                      },
                    },
                    {
                      configMap: {
                        name: 'ql3-worker-product-config-live',
                        items: [{ key: 'capabilities.json', path: 'capabilities.json' }],
                      },
                    },
                  ],
                },
              },
              { name: 'materialized-authority', emptyDir: { medium: 'Memory', sizeLimit: '4Mi' } },
              { name: 'worker-state', persistentVolumeClaim: { claimName: 'ql3-worker-live-state' } },
              { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
            ],
          },
        },
      },
    });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=240s',
    ], { capture: true, quiet: true });
    const productPodA = await currentPod(podAfterIdentity.metadata.uid);
    const productSessionA = await waitForOnlineSession();
    await waitForHeartbeatAudit(1);
    const productEventsA = productEvents(productPodA);
    assert.equal(productEventsA.some((event) => event.event === 'active'), true);

    const fourth = await approveAndExecute({
      generation: 'generation-live_generation_4',
      deliveryId: '323e4567-e89b-42d3-a456-426614174904',
      credentialId: 'live_generation_4',
      previousCredentialId: 'live_generation_3',
      auditIds: {
        proposal: '723e4567-e89b-42d3-a456-426614174901',
        decision: '723e4567-e89b-42d3-a456-426614174902',
        consume: '723e4567-e89b-42d3-a456-426614174903',
      },
    });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=240s',
    ], { capture: true, quiet: true });
    const productPodB = await currentPod(productPodA.metadata.uid);
    const productSessionB = await waitForOnlineSession(productSessionA.sessionId);
    await waitForHeartbeatAudit(2);
    const productEventsB = productEvents(productPodB);
    assert.equal(productEventsB.some((event) => event.event === 'active'), true);

    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'ql3-worker-live-identity', namespace: NAMESPACE },
      type: 'Opaque',
      stringData: {
        'ca.crt': pkiMaterial.ca,
        'tls.key': pkiMaterial.newClientKey,
        'tls.crt': pkiMaterial.newClientCertificate,
      },
    });
    kubectl([
      '-n', NAMESPACE, 'patch', 'deployment', DEPLOYMENT, '--type=merge',
      '-p', JSON.stringify({ spec: { template: { metadata: { annotations: {
        'qinglong.io/worker-identity-generation': 'product-identity-b',
      } } } } }),
    ], { capture: true, quiet: true });
    kubectl([
      '-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`,
      '--timeout=240s',
    ], { capture: true, quiet: true });
    const productPodC = await currentPod(productPodB.metadata.uid);
    const productSessionC = await waitForOnlineSession(productSessionB.sessionId);
    await waitForHeartbeatAudit(3);
    const productEventsC = productEvents(productPodC);
    assert.equal(productEventsC.some((event) => event.event === 'active'), true);

    const finalDrainStartedAt = Date.now();
    kubectl([
      '-n', NAMESPACE, 'scale', `deployment/${DEPLOYMENT}`, '--replicas=0',
    ], { capture: true, quiet: true });
    const finalOffline = await waitFor(
      'production Worker final offline Session',
      30_000,
      async () => {
        const current = await session();
        return current?.sessionId === productSessionC.sessionId &&
          current.status === 'offline'
          ? { ready: true, value: current }
          : { ready: false, fact: JSON.stringify(current) };
      },
    );
    const productObservations = await observations();
    for (const productSession of [
      productSessionA,
      productSessionB,
      productSessionC,
    ]) {
      const states = productObservations
        .filter((entry) => entry.sessionId === productSession.sessionId)
        .map((entry) => entry.status);
      assert.equal(states.includes('online'), true);
      assert.equal(states.includes('draining'), true);
      assert.equal(states.includes('offline'), true);
    }
    assert.equal(productSessionA.generation < productSessionB.generation, true);
    assert.equal(productSessionB.generation < productSessionC.generation, true);
    assert.equal(finalOffline.status, 'offline');

    const productDurability = (await migrationDatabase.pool.query(
      `SELECT
         count(*) FILTER (WHERE operation_id = 'worker.register')::integer
           AS "registerAudits",
         count(*) FILTER (WHERE operation_id = 'worker.transition')::integer
           AS "transitionAudits",
         count(*) FILTER (WHERE operation_id = 'worker.heartbeat')::integer
           AS "heartbeatAudits",
         NOT EXISTS (
           SELECT 1 FROM "ql3"."worker_credentials"
            WHERE to_jsonb(worker_credentials)::text LIKE '%ql3w_%'
         ) AS "credentialSecretsAbsent"
       FROM "ql3"."security_audit_events"
      WHERE subject_type = 'worker' AND subject_id = $1`,
      [WORKER_ID],
    )).rows[0];
    assert.equal(productDurability.registerAudits >= 3, true);
    assert.equal(productDurability.transitionAudits >= 6, true);
    assert.equal(productDurability.heartbeatAudits >= 3, true);
    assert.equal(productDurability.credentialSecretsAbsent, true);
    const productionWorkerEvidence = Object.freeze({
      workerImageId: JSON.parse(run(docker, [
        'image', 'inspect', workerImage,
      ], { capture: true, quiet: true }).stdout)[0].Id,
      controlImageId: JSON.parse(run(docker, [
        'image', 'inspect', controlImage,
      ], { capture: true, quiet: true }).stdout)[0].Id,
      podUids: [
        productPodA.metadata.uid,
        productPodB.metadata.uid,
        productPodC.metadata.uid,
      ],
      nodeNames: [
        productPodA.spec.nodeName,
        productPodB.spec.nodeName,
        productPodC.spec.nodeName,
      ],
      sessionIds: [
        productSessionA.sessionId,
        productSessionB.sessionId,
        productSessionC.sessionId,
      ],
      generations: [
        productSessionA.generation,
        productSessionB.generation,
        productSessionC.generation,
      ],
      observationCount: productObservations.length,
      gracefulDrainElapsedMs: Date.now() - finalDrainStartedAt,
      terminationGracePeriodSeconds: 360,
      startupReconciliationBeforeOnline: true,
      everySessionObservedOnlineDrainingOffline: true,
      credentialRolloutCreatedFreshSession: true,
      identityRolloutCreatedFreshSession: true,
      pvcReusedAcrossProductSessions: true,
      serviceAccountTokenMounted: false,
      ...productDurability,
      fourthCredentialId: fourth.candidate.credentialId,
    });
    const finalDeployment = kubectlJson([
      '-n', NAMESPACE, 'get', 'deployment', DEPLOYMENT,
    ]);
    const finalPvc = kubectlJson([
      '-n', NAMESPACE, 'get', 'pvc', 'ql3-worker-live-state',
    ]);
    const finalTarget = kubectlJson([
      '-n', NAMESPACE, 'get', 'secret', TARGET_SECRET,
    ]);
    assert.equal(
      finalTarget.metadata.labels['qinglong.io/worker-credential-target'],
      'v3',
    );
    assert.equal(
      productPodC.spec.volumes?.some((volume) =>
        volume.projected?.sources?.some((source) =>
          source.serviceAccountToken !== undefined)),
      false,
    );
    const approvalExecutionFacts = (await migrationDatabase.pool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM "ql3"."worker_credential_management_plans") AS "plans",
         (SELECT count(*)::integer
            FROM "ql3"."approval_requests"
           WHERE state = 'consumed' AND version = 3) AS "consumedApprovals",
         (SELECT count(*)::integer
            FROM "ql3"."approved_action_dispatches") AS "dispatches",
         (SELECT count(*)::integer
            FROM "ql3"."approved_action_executions"
           WHERE status = 'succeeded') AS "succeededExecutions",
         (SELECT count(*)::integer
            FROM "ql3"."worker_credentials") AS "credentials",
         (SELECT count(*)::integer
            FROM "ql3"."worker_credential_deliveries"
           WHERE state = 'published' AND version = 2) AS "publishedDeliveries",
         (SELECT count(*)::integer
            FROM "ql3"."security_audit_events"
           WHERE operation_id IN (
             'approval.request', 'approval.decide', 'approval.consume',
             'worker_credential.issue'
           )) AS "auditEvents"`,
    )).rows[0];
    assert.deepEqual(approvalExecutionFacts, {
      plans: 4,
      consumedApprovals: 4,
      dispatches: 4,
      succeededExecutions: 4,
      credentials: 4,
      publishedDeliveries: 4,
      auditEvents: 16,
    });
    assert.equal(authorizationRechecks, 9);
    assert.equal(managerReadiness.currentUser, 'ql3_worker_credential_manager');
    assert.equal(
      first.executorDatabase.currentUser,
      'ql3_worker_credential_executor',
    );
    assert.equal(
      second.executorDatabase.currentUser,
      'ql3_worker_credential_executor',
    );
    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      sourceRevision,
      kubernetes: {
        distribution: 'k3s',
        image: K3S_IMAGE,
        imageDigest: K3S_DIGEST,
        architecture: image.Architecture,
        serverVersion: kubectlJson(['version']).serverVersion.gitVersion,
      },
      postgresql: {
        image: POSTGRES_IMAGE,
        imageDigest: POSTGRES_DIGEST,
        imageId: postgresImage.Id,
        architecture: postgresImage.Architecture,
        contractVersion: managerReadiness.contractVersion,
        migrationId: managerReadiness.migrationIds.at(-1),
        managerRole: managerReadiness.currentUser,
        executorRole: first.executorDatabase.currentUser,
      },
      approvalExecution: {
        ...approvalExecutionFacts,
        planDigests: [
          first.planDigest,
          second.planDigest,
          thirdApproval.planned.plan.planDigest,
          fourth.planDigest,
        ],
        approvalRequestIds: [
          first.approvalRequestId,
          second.approvalRequestId,
          thirdApproval.proposed.approvalRequest.id,
          fourth.approvalRequestId,
        ],
        dispatchIds: [
          first.dispatchId,
          second.dispatchId,
          thirdApproval.command.dispatchId,
          fourth.dispatchId,
        ],
        hostAuthorizationRechecks: authorizationRechecks,
        tokenRequestAfterApprovalConsumption: true,
        executionReplayWithoutTokenRequest: true,
        tokenOrSecretPersistedInPlan: false,
      },
      credentialRollout: {
        secretSeparatedFromTlsIdentity: true,
        generations: [
          first.candidate.deploymentGeneration,
          second.candidate.deploymentGeneration,
          executorPublication.generation,
          fourth.candidate.deploymentGeneration,
        ],
        publicationDigests: [
          first.publication.publicationDigest,
          second.publication.publicationDigest,
          executorPublication.publicationDigest,
          fourth.publication.publicationDigest,
        ],
        recreateStoppedOldBeforeStartingNew:
          afterCredentialRollout.indexOf(`stop ${podA.metadata.uid}`) <
          afterCredentialRollout.findIndex((line) =>
            line.startsWith(`start ${podB.metadata.uid} `)),
        executorJobStoppedOldBeforeStartingNew:
          afterExecutorJobRollout.indexOf(`stop ${podAfterCrash.metadata.uid}`) <
          afterExecutorJobRollout.findIndex((line) =>
            line.startsWith(`start ${podAfterExecutorJob.metadata.uid} `)),
      },
      callerDrivenExecutorJob: {
        image: executorJob.image,
        firstJobName: executorJob.jobName,
        firstPodUid: executorJob.podUid,
        firstOutput: executorJob.output,
        replayJobName: executorReplayJob.jobName,
        replayPodUid: executorReplayJob.podUid,
        replayOutput: executorReplayJob.output,
        backoffLimit: 0,
        projectedIssuerTokenSeconds:
          executorJob.projectedIssuerTokenSeconds,
        apiServerEgressCidr: `${apiServiceAddress}/32`,
        apiServerBackendEgressCidr: `${k3sAddress}/32`,
        apiServerBackendPort: 6443,
        postgresEgressCidr: `${postgresAddress}/32`,
      },
      rbac: {
        tokenIssuerImpersonatedUser: TOKEN_ISSUER_USER,
        tokenIssuerExactServiceAccountBound: true,
        hostTokenRequestSessions: tokenRequestSessions,
        executorJobTokenRequestSessions: 1,
        shortLivedTokenRequestSeconds:
          tokenRequestEvidence.tokenLifetimeSeconds,
        issuerAllowedChecks: tokenRequestEvidence.issuerAllowedChecks,
        issuerDeniedChecks: tokenRequestEvidence.issuerDeniedChecks,
        serviceAccountAutomount: false,
        workerPodServiceAccountTokenProjected: false,
        separateStageNamespace: STAGE_NAMESPACE !== NAMESPACE,
        allowedChecks: tokenRequestEvidence.allowedChecks,
        deniedChecks: tokenRequestEvidence.deniedChecks,
        tokenNeverReturnedBySession: true,
        restrictedClientDisposedAfterEachOperation: true,
        adapterUsedRestrictedToken: true,
      },
      recovery: {
        pvcPhase: finalPvc.status.phase,
        sameClaimAfterCredentialRollout: true,
        sameClaimAfterForcedPodLoss: afterCrash.length >= 3,
        oldPodUid: podA.metadata.uid,
        rotatedPodUid: podB.metadata.uid,
        crashReplacementPodUid: podAfterCrash.metadata.uid,
        executorJobReplacementPodUid: podAfterExecutorJob.metadata.uid,
        identityReplacementPodUid: podAfterIdentity.metadata.uid,
        durableJournalRecords: finalJournal.length,
      },
      identityRollout: {
        generation:
          finalDeployment.spec.template.metadata.annotations[
            'qinglong.io/worker-identity-generation'
          ],
        caDigest: sha256(pkiMaterial.ca),
        observedByReplacement: true,
      },
      productionWorker: productionWorkerEvidence,
      gates: {
        realKubernetesApi: true,
        secretAndDeploymentResourceVersionCas: true,
        recreateOrderingObserved: true,
        pvcJournalSurvivedRolloutAndForcedPodLoss: true,
        explicitIdentityGenerationRolloutObserved: true,
        strongUserPlanApprovalAndDispatchPersisted: true,
        managerExecutorDatabaseRolesSeparated: true,
        approvalConsumedBeforeTokenRequest: true,
        leastPrivilegeTokenIssuerRbac: true,
        tokenRequestSessionDisposed: true,
        restrictedCredentialDeliveryRbac: true,
        realCallerDrivenExecutorJob: true,
        executorJobExactReplayWithoutTokenRequest: true,
        executorJobUsesProjectedShortLivedIssuerToken: true,
        executorJobExactNetworkEgress: true,
        productionWorkerImageInKubernetes: true,
        productionWorkerIngressComposition: true,
        productionSessionReplacement: true,
        productionStartupReconciliation: true,
        productionGracefulDrainToOffline: true,
        passed: true,
      },
      limitations: [...LIMITATIONS],
    };
    const audit = validateWorkerKubernetesRolloutLiveReport(report);
    assert.deepEqual(audit.findings, []);
    writePrivateReport(reportFile, report);
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        fixture: FIXTURE,
        reportWritten: true,
        passed: true,
      }) + '\n',
    );
  } finally {
    first = undefined;
    second = undefined;
    if (managerDatabase) {
      await managerDatabase.close().catch(() => undefined);
    }
    if (migrationDatabase) {
      await migrationDatabase.close().catch(() => undefined);
    }
    if (postgresCreated) {
      run(docker, ['rm', '-f', '-v', postgresContainer], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (created) {
      run(docker, ['rm', '-f', '-v', container], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (adminImageBuilt) {
      run(docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (workerImageBuilt) {
      run(docker, ['image', 'rm', '-f', workerImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (controlImageBuilt) {
      run(docker, ['image', 'rm', '-f', controlImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ql3 Worker Kubernetes rollout live contract failed: ${error.stack || error}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { writePrivateReport };
