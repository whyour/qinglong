#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  validateCloudNativePgDrEvidence,
} = require('./ql3-cloudnativepg-dr-evidence-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const K3S_IMAGE =
  'rancher/k3s:v1.32.8-k3s1@sha256:f9f125ef9c662a231a98c507afdd3ba9a94d5f02631f946d1d34000ef67f7263';
const REGISTRY_IMAGE =
  'registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';
const SKOPEO_IMAGE =
  'quay.io/skopeo/stable:v1.20.0@sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4';
const K3S_VERSION = '1.32.8';
const K3S_EVICTION_HARD =
  'memory.available<100Mi,nodefs.available<64Mi,imagefs.available<64Mi,nodefs.inodesFree<1%';
const DOCKER_SCOPE_LABEL =
  'io.qinglong.ql3.live=cloudnativepg-barman-disaster-recovery';
const DOCKER_RUN_LABEL_KEY = 'io.qinglong.ql3.run';
const MINIMUM_DR_FREE_BYTES = 35n * 1024n * 1024n * 1024n;
const CERT_MANAGER_VERSION = '1.20.3';
const BARMAN_VERSION = '0.13.0';
const CNPG_VERSION = '1.30.0';
const CERT_MANAGER_MANIFEST_URL =
  'https://github.com/cert-manager/cert-manager/releases/download/v1.20.3/cert-manager.yaml';
const CERT_MANAGER_MANIFEST_SHA256 =
  '7ee74ba06845213e96d8ceaff3d20dd51e682765c1418eddda4e8780ba082261';
const BARMAN_MANIFEST_URL =
  'https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml';
const BARMAN_MANIFEST_SHA256 =
  'd2e71e7b06822448f1a421f05781846cfdb9cc621e7ef32eef5e20c5133213b0';
const CNPG_MANIFEST_URL =
  'https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.0/cnpg-1.30.0.yaml';
const CNPG_MANIFEST_SHA256 =
  'f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88';
const POSTGRES_DATABASE_ROLE_MANIFEST = path.join(
  ROOT,
  'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/database-roles.yaml',
);
const POSTGRES_ROLE_NAMES = Object.freeze([
  'ql3_admin',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
  'ql3_ai_maintenance',
  'ql3_approval_manager',
  'ql3_automation_manager',
  'ql3_migration',
  'ql3_package_executor',
  'ql3_package_manager',
  'ql3_runtime',
  'ql3_worker_credential_executor',
  'ql3_worker_credential_manager',
  'ql3_worker_ingress',
]);
const REGISTRY_DATA_TARGETS = Object.freeze(['/var/lib/registry']);
const K3S_DATA_TARGETS = Object.freeze([
  '/var/lib/cni',
  '/var/lib/kubelet',
  '/var/lib/rancher/k3s',
  '/var/log',
]);
const REVIEWED_DOCKER_DATA_TARGETS = new Set([
  ...REGISTRY_DATA_TARGETS,
  ...K3S_DATA_TARGETS,
]);

function assertCloudNativePgDrRunnerCapacity(
  statfs = fs.statfsSync,
  filesystemPath = os.tmpdir(),
) {
  assert.equal(typeof statfs, 'function');
  assert.equal(path.isAbsolute(filesystemPath), true);
  const stats = statfs(filesystemPath, { bigint: true });
  assert.ok(stats && typeof stats === 'object');
  assert.equal(typeof stats.bavail, 'bigint');
  assert.equal(typeof stats.bsize, 'bigint');
  assert.ok(stats.bavail >= 0n && stats.bsize > 0n);
  const availableBytes = stats.bavail * stats.bsize;
  assert.ok(
    availableBytes >= MINIMUM_DR_FREE_BYTES,
    `CloudNativePG DR live gate requires at least 35 GiB free; found ${availableBytes} bytes`,
  );
  return Object.freeze({
    minimumBytes: MINIMUM_DR_FREE_BYTES,
    availableBytes,
  });
}

const IMAGES = Object.freeze({
  cnpg: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb',
  postgres:
    'ghcr.io/cloudnative-pg/postgresql:18.4-minimal-trixie@sha256:24d229d801663f95b584416f8ebdfad4849b1a3fa4cfcf95a7f026df7aa6e22d',
  barman:
    'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96',
  barmanSidecar:
    'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288',
  certManager:
    'quay.io/jetstack/cert-manager-controller:v1.20.3@sha256:6c13d61e0348a5bc3477f8ea9a928624300b30d19b1c72a7d2b90372fc713db4',
  certManagerCainjector:
    'quay.io/jetstack/cert-manager-cainjector:v1.20.3@sha256:06ad347fe0dc2eb84cc355c26f6752e05e87dceb6447f5cd29b963dd66dfd8bd',
  certManagerWebhook:
    'quay.io/jetstack/cert-manager-webhook:v1.20.3@sha256:a61e817632cebed3bb59a189327e786fa3fdd7597167d994a1848d98fd55848f',
  minio:
    'docker.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
  minioClient:
    'docker.io/minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727',
});

const PLATFORM_DIGESTS = Object.freeze({
  amd64: Object.freeze({
    cnpg: 'sha256:091d306935cfdf646debfe78010d59ebfb572150eb6eb922b0203873c0c68841',
    barman:
      'sha256:417449fe4f6f0a56acdeb30e4131930815f2b46b9afeb808059b57aa8b4c2ef5',
    barmanSidecar:
      'sha256:15cb1a01e7c5235eedac2061cab8208e5f7c39dbda292f9c2d4ddaa0c1f211e6',
    certManager:
      'sha256:1e4af57beb469cc3bb0fb48b9201caea2723819b9ffd3c3ea98568f55b4dd38b',
    certManagerCainjector:
      'sha256:a2b12d27950d1603d2c8168c3ccd95d07b93ce6ec4b530316196a31db592a9c0',
    certManagerWebhook:
      'sha256:953a97df613f7da7eda8ce4b1c8d8e6b50963db0800fab595d040db6eb5cb060',
    minio:
      'sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2',
    minioClient:
      'sha256:eb4ea9884b77704230e2423e9004d2fa738dc272876b9cc41a297d29443b8780',
    postgres:
      'sha256:67e56bcbe50a58e60509815dd89e58effc5f331ab844f66331d945cd42131e8d',
  }),
  arm64: Object.freeze({
    cnpg: 'sha256:6c7926147fd23a053dea6605d61c013d43bfd411be3532e7500ef2d2b68bb98c',
    barman:
      'sha256:de612e3ad8633a198b91ffbea53848407424155daf2183d656490d843a83b100',
    barmanSidecar:
      'sha256:f53e168e341661cd76334215ead9dfd69f06117685d3232206192cf25218da71',
    certManager:
      'sha256:af62a025ae4f8fd03209b5e0760868296bad5a9370aab0c91ad3b5476bcb282d',
    certManagerCainjector:
      'sha256:3c052c134ad1b93122b957f4d214aaa9d85a37b5ff15acc5b4d86f50e3ed822e',
    certManagerWebhook:
      'sha256:7c510875e038f79f7fba707b5f86d8736777a4dfefcd42179b08844ee75e685b',
    minio:
      'sha256:9966a92a734f9411e32f4f41d7d9d826fcdc0f68c4e20b70295bd4e7c11f8a2f',
    minioClient:
      'sha256:37d109dddbbb2c95873f5fc81ac93f37023264770fc580a7564148892087b1b7',
    postgres:
      'sha256:2adbb634a1c0af8cb036e81200aaa7c8b62517bf5e501699926b337bd9f863f1',
  }),
});

function run(binary, args, options = {}) {
  if (!options.quiet) {
    process.stderr.write(`+ ${path.basename(binary)} ${args.join(' ')}\n`);
  }
  const result = spawnSync(binary, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : [
          options.input === undefined ? 'inherit' : 'pipe',
          'inherit',
          'inherit',
        ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${path.basename(binary)} failed with ${String(result.status)}: ${
        result.stderr || result.stdout || ''
      }`,
    );
  }
  return Object.freeze({
    status: result.status,
    stdout: options.capture ? result.stdout.trim() : '',
    stderr: options.capture ? result.stderr.trim() : '',
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, inspect) {
  const startedAt = Date.now();
  let last = 'not observed';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = inspect();
      if (result?.ready) {
        return Object.freeze({
          elapsedMs: Date.now() - startedAt,
          value: result.value,
        });
      }
      if (result?.fact) last = result.fact;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`${description} timed out: ${last}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeArchitecture(value) {
  if (value === 'x86_64' || value === 'x64') return 'amd64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

function privateDockerDataBindArgs(root, identity, targets) {
  assert.ok(path.isAbsolute(root), 'Docker data root must be absolute');
  assert.match(identity, /^[a-z0-9][a-z0-9-]{0,127}$/);
  assert.ok(Array.isArray(targets) && targets.length > 0);
  assert.equal(new Set(targets).size, targets.length);
  assert.ok(!root.includes(','), 'Docker data root cannot contain a comma');

  return targets.flatMap((target, index) => {
    assert.ok(
      REVIEWED_DOCKER_DATA_TARGETS.has(target),
      `unreviewed Docker data target ${target}`,
    );
    const directory = path.join(
      root,
      identity,
      `${String(index).padStart(2, '0')}-${path.basename(target)}`,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    return ['--mount', `type=bind,src=${directory},dst=${target}`];
  });
}

function redactRuntimeText(value, sensitiveValues) {
  return sensitiveValues.reduce((redacted, sensitive) => {
    if (typeof sensitive !== 'string' || sensitive.length === 0)
      return redacted;
    return redacted.split(sensitive).join('[REDACTED]');
  }, String(value));
}

function downloadManifest(curl, target, url) {
  run(curl, [
    '--http1.1',
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--retry',
    '4',
    '--retry-all-errors',
    '--connect-timeout',
    '15',
    '--max-time',
    '300',
    '--output',
    target,
    url,
  ]);
  fs.chmodSync(target, 0o600);
}

function manifestSource(environmentKey, fallback, curl, target, url) {
  const selected = process.env[environmentKey] || fallback;
  if (selected && fs.existsSync(selected)) return path.resolve(selected);
  downloadManifest(curl, target, url);
  return target;
}

function replaceExactlyOnce(source, from, to) {
  return replaceExactly(source, from, to, 1);
}

function replaceExactly(source, from, to, expectedCount) {
  assert.ok(Number.isSafeInteger(expectedCount) && expectedCount >= 1);
  const occurrences = source.split(from).length - 1;
  assert.equal(
    occurrences,
    expectedCount,
    `expected exactly ${String(expectedCount)} manifest references ${from}`,
  );
  return source.split(from).join(to);
}

function reviewedManifest(source, target, expectedSha256, replacements) {
  const stat = fs.lstatSync(source);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size >= 1024,
    'release manifest must be a non-symlink regular file',
  );
  const bytes = fs.readFileSync(source);
  assert.equal(sha256(bytes), expectedSha256, 'release manifest digest drift');
  let text = bytes.toString('utf8');
  for (const [from, to, expectedCount = 1] of replacements) {
    text = replaceExactly(text, from, to, expectedCount);
  }
  fs.writeFileSync(target, text, { mode: 0o600, flag: 'wx' });
  return Object.freeze({
    sourceSha256: expectedSha256,
    pinnedSha256: sha256(Buffer.from(text)),
    target,
  });
}

function imageIdDigest(value) {
  const match = String(value || '').match(/sha256:[a-f0-9]{64}$/);
  assert.ok(match, `invalid Kubernetes imageID ${String(value)}`);
  return match[0];
}

function platformDigestFromImageIndex(index, architecture) {
  const manifests = Array.isArray(index?.manifests) ? index.manifests : [];
  const matching = manifests.filter(
    (manifest) =>
      manifest?.platform?.os === 'linux' &&
      normalizeArchitecture(manifest.platform.architecture) === architecture,
  );
  assert.equal(
    matching.length,
    1,
    `expected one linux/${architecture} manifest in the reviewed image index`,
  );
  return imageIdDigest(matching[0].digest);
}

function digestOnlyReference(image) {
  const at = image.lastIndexOf('@');
  assert.ok(at > 0, `reviewed image must contain a digest: ${image}`);
  const digest = image.slice(at + 1);
  imageIdDigest(digest);
  const named = image.slice(0, at);
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const repository = colon > slash ? named.slice(0, colon) : named;
  return `${repository}@${digest}`;
}

function runtimeImageEvidence(
  pod,
  containerName,
  reviewedImage,
  expectedPlatformDigest,
) {
  const status = (pod?.status?.containerStatuses || []).find(
    (candidate) => candidate.name === containerName,
  );
  assert.ok(status, `missing runtime container status ${containerName}`);
  const imageId = imageIdDigest(status.imageID);
  const indexDigest = imageIdDigest(reviewedImage);
  assert.equal(imageId, expectedPlatformDigest);
  return Object.freeze({
    imageId,
    indexDigest,
    platformDigest: expectedPlatformDigest,
  });
}

function mirrorPlatformImage(
  docker,
  registry,
  sourceImage,
  repository,
  architecture,
  expectedPlatformDigest,
) {
  assert.match(repository, /^[a-z][a-z0-9-]*$/);
  const localDestinationTag = `localhost:5000/ql3/${repository}:reviewed-${architecture}`;
  run(
    docker,
    [
      'run',
      '--rm',
      '--network',
      `container:${registry}`,
      SKOPEO_IMAGE,
      'copy',
      '--retry-times',
      '4',
      '--retry-delay',
      '2s',
      '--preserve-digests',
      '--override-os',
      'linux',
      '--override-arch',
      architecture,
      '--dest-tls-verify=false',
      `docker://${digestOnlyReference(sourceImage)}`,
      `docker://${localDestinationTag}`,
    ],
    { capture: true, quiet: true },
  );
  const inspection = JSON.parse(
    run(
      docker,
      [
        'run',
        '--rm',
        '--network',
        `container:${registry}`,
        SKOPEO_IMAGE,
        'inspect',
        '--tls-verify=false',
        `docker://${localDestinationTag}`,
      ],
      { capture: true, quiet: true },
    ).stdout,
  );
  assert.equal(
    inspection.Digest,
    expectedPlatformDigest,
    `local registry digest drift for ${repository}`,
  );
  return `${registry}:5000/ql3/${repository}@${expectedPlatformDigest}`;
}

function buildClusterControlImage({
  docker,
  registry,
  registryPort,
  architecture,
  suffix,
}) {
  assert.match(registry, /^ql3-barman-dr-[0-9]+-[a-f0-9]{6}-registry$/);
  assert.match(registryPort, /^127\.0\.0\.1:[0-9]+$/);
  assert.match(architecture, /^(?:amd64|arm64)$/);
  assert.match(suffix, /^[0-9]+-[a-f0-9]{6}$/);
  const repository = `${registryPort}/ql3/cluster-control`;
  const localTag = `${repository}:dr-${suffix}`;
  run(docker, [
    'build',
    '--file',
    'deploy/containers/ql3-cluster-control/Dockerfile',
    '--platform',
    `linux/${architecture}`,
    '--provenance=false',
    '--target',
    'runtime',
    '--tag',
    localTag,
    '--build-arg',
    'SOURCE_REVISION=cloudnativepg-barman-live',
    '.',
  ]);
  run(docker, ['push', localTag]);
  const inspection = JSON.parse(
    run(docker, ['image', 'inspect', localTag], {
      capture: true,
      quiet: true,
    }).stdout,
  );
  assert.equal(inspection.length, 1);
  const prefix = `${repository}@`;
  const matching = (inspection[0].RepoDigests || []).filter((reference) =>
    reference.startsWith(prefix),
  );
  assert.equal(
    matching.length,
    1,
    'missing exact local image repository digest',
  );
  const platformDigest = imageIdDigest(matching[0]);
  return Object.freeze({
    localTag,
    platformDigest,
    runtimeImage: `${registry}:5000/ql3/cluster-control@${platformDigest}`,
  });
}

function kubernetesSecret(namespace, name, values) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { namespace, name },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        Buffer.from(value, 'utf8').toString('base64'),
      ]),
    ),
  };
}

function postgresRoleSecretResources(credentials) {
  assert.ok(credentials && typeof credentials === 'object');
  assert.deepEqual(Object.keys(credentials).sort(), POSTGRES_ROLE_NAMES);
  const items = POSTGRES_ROLE_NAMES.map((role) => {
    const password = credentials[role];
    assert.match(password, /^[A-Za-z0-9_-]{32,128}$/);
    return Object.freeze({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        namespace: 'ql3-dr',
        name: `ql3-postgres-${role
          .replace(/^ql3_/, '')
          .replaceAll('_', '-')}-auth`,
      },
      type: 'kubernetes.io/basic-auth',
      data: {
        username: Buffer.from(role, 'utf8').toString('base64'),
        password: Buffer.from(password, 'utf8').toString('base64'),
      },
    });
  });
  return Object.freeze({
    apiVersion: 'v1',
    kind: 'List',
    items: Object.freeze(items),
  });
}

function postgresMigrationJobResource({ controlImage }) {
  imageIdDigest(controlImage);
  assert.match(
    controlImage,
    /^ql3-barman-dr-[0-9]+-[a-f0-9]{6}-registry:5000\/ql3\/cluster-control@sha256:[a-f0-9]{64}$/,
  );
  const roleSecret = 'ql3-postgres-migration-auth';
  const secretValue = (name, key) => ({
    name,
    valueFrom: { secretKeyRef: { name: roleSecret, key } },
  });
  return Object.freeze({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      namespace: 'ql3-dr',
      name: 'ql3-cluster-migration',
      labels: {
        'app.kubernetes.io/name': 'ql3-cluster-migration',
        'app.kubernetes.io/component': 'database-migration',
        'app.kubernetes.io/part-of': 'qinglong3',
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-cluster-migration',
            'app.kubernetes.io/component': 'database-migration',
            'app.kubernetes.io/part-of': 'qinglong3',
          },
        },
        spec: {
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
              name: 'migration',
              image: controlImage,
              imagePullPolicy: 'IfNotPresent',
              command: [
                'node',
                '/opt/qinglong/node_modules/@qinglong/cluster-postgres/dist/migration/migrationCli.js',
              ],
              env: [
                { name: 'QL3_POSTGRES_TLS_MODE', value: 'verify-full' },
                {
                  name: 'QL3_POSTGRES_TLS_CA_FILE',
                  value: '/var/run/secrets/qinglong3/postgres/ca.crt',
                },
                {
                  name: 'QL3_POSTGRES_TLS_SERVERNAME',
                  value: 'ql3-postgres-rw.ql3-dr.svc',
                },
                {
                  name: 'QL3_POSTGRES_MIGRATION_HOST',
                  value: 'ql3-postgres-rw.ql3-dr.svc',
                },
                { name: 'QL3_POSTGRES_MIGRATION_PORT', value: '5432' },
                {
                  name: 'QL3_POSTGRES_MIGRATION_DATABASE',
                  value: 'qinglong',
                },
                secretValue('QL3_POSTGRES_MIGRATION_USER', 'username'),
                secretValue('QL3_POSTGRES_MIGRATION_PASSWORD', 'password'),
                {
                  name: 'QL3_POSTGRES_APPLICATION_NAME',
                  value: 'qinglong3-cluster-migration',
                },
              ],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '1', memory: '256Mi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                {
                  name: 'postgres-ca',
                  mountPath: '/var/run/secrets/qinglong3/postgres',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
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
  });
}

function postgresRestoreApplicationProbeResources({
  clusterName,
  controlImage,
  apiCredentialPepper,
}) {
  assert.match(clusterName, /^ql3-postgres-restore-(?:latest|pitr)$/);
  imageIdDigest(controlImage);
  assert.match(
    controlImage,
    /^ql3-barman-dr-[0-9]+-[a-f0-9]{6}-registry:5000\/ql3\/cluster-control@sha256:[a-f0-9]{64}$/,
  );
  assert.match(apiCredentialPepper, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    Buffer.from(apiCredentialPepper, 'base64url').toString('base64url'),
    apiCredentialPepper,
  );
  const suffix = clusterName.endsWith('-latest') ? 'latest' : 'pitr';
  const name = `ql3-dr-application-${suffix}`;
  const secretName = `${name}-security`;
  const databaseSecret = 'ql3-postgres-runtime-auth';
  const secretValue = (name, secret, key) => ({
    name,
    valueFrom: { secretKeyRef: { name: secret, key } },
  });
  const labels = Object.freeze({
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/component': 'restore-application-probe',
    'app.kubernetes.io/part-of': 'qinglong3',
    'ql3.cloud/restore-cluster': clusterName,
  });
  return Object.freeze({
    apiVersion: 'v1',
    kind: 'List',
    items: Object.freeze([
      kubernetesSecret('ql3-dr', secretName, {
        'api-credential-pepper': apiCredentialPepper,
      }),
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { namespace: 'ql3-dr', name, labels },
        spec: {
          replicas: 1,
          minReadySeconds: 2,
          progressDeadlineSeconds: 300,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              automountServiceAccountToken: false,
              terminationGracePeriodSeconds: 15,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'cluster-control',
                  image: controlImage,
                  imagePullPolicy: 'IfNotPresent',
                  env: [
                    { name: 'QL_DEPLOYMENT_PROFILE', value: 'cluster-control' },
                    { name: 'QL3_CLUSTER_CONTROL_ENABLED', value: 'true' },
                    { name: 'QL3_WORKER_INGRESS_ENABLED', value: 'false' },
                    { name: 'QL3_CLUSTER_HTTP_HOST', value: '0.0.0.0' },
                    { name: 'QL3_CLUSTER_HTTP_PORT', value: '5800' },
                    {
                      name: 'QL3_CLUSTER_REPLICA_ID',
                      valueFrom: {
                        fieldRef: {
                          apiVersion: 'v1',
                          fieldPath: 'metadata.name',
                        },
                      },
                    },
                    { name: 'QL3_POSTGRES_TLS_MODE', value: 'verify-full' },
                    {
                      name: 'QL3_POSTGRES_TLS_CA_FILE',
                      value: '/var/run/secrets/qinglong3/postgres/ca.crt',
                    },
                    {
                      name: 'QL3_POSTGRES_TLS_SERVERNAME',
                      value: `${clusterName}-rw.ql3-dr.svc`,
                    },
                    {
                      name: 'QL3_POSTGRES_RUNTIME_HOST',
                      value: `${clusterName}-rw.ql3-dr.svc`,
                    },
                    { name: 'QL3_POSTGRES_RUNTIME_PORT', value: '5432' },
                    {
                      name: 'QL3_POSTGRES_RUNTIME_DATABASE',
                      value: 'qinglong',
                    },
                    secretValue(
                      'QL3_POSTGRES_RUNTIME_USER',
                      databaseSecret,
                      'username',
                    ),
                    secretValue(
                      'QL3_POSTGRES_RUNTIME_PASSWORD',
                      databaseSecret,
                      'password',
                    ),
                    {
                      name: 'QL3_POSTGRES_APPLICATION_NAME',
                      value: `qinglong3-dr-${suffix}`,
                    },
                    { name: 'QL3_POSTGRES_MAX_CONNECTIONS', value: '2' },
                    secretValue(
                      'QL3_API_CREDENTIAL_PEPPER',
                      secretName,
                      'api-credential-pepper',
                    ),
                  ],
                  ports: [{ name: 'http', containerPort: 5800 }],
                  startupProbe: {
                    httpGet: { path: '/livez', port: 'http' },
                    periodSeconds: 2,
                    timeoutSeconds: 1,
                    failureThreshold: 30,
                  },
                  readinessProbe: {
                    httpGet: { path: '/readyz', port: 'http' },
                    periodSeconds: 2,
                    timeoutSeconds: 1,
                    failureThreshold: 5,
                  },
                  livenessProbe: {
                    httpGet: { path: '/livez', port: 'http' },
                    periodSeconds: 10,
                    timeoutSeconds: 2,
                    failureThreshold: 3,
                  },
                  resources: {
                    requests: { cpu: '50m', memory: '128Mi' },
                    limits: { cpu: '1', memory: '512Mi' },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  volumeMounts: [
                    { name: 'tmp', mountPath: '/tmp' },
                    {
                      name: 'postgres-ca',
                      mountPath: '/var/run/secrets/qinglong3/postgres',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'tmp',
                  emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
                },
                {
                  name: 'postgres-ca',
                  secret: {
                    secretName: `${clusterName}-ca`,
                    defaultMode: 292,
                    items: [{ key: 'ca.crt', path: 'ca.crt' }],
                  },
                },
              ],
            },
          },
        },
      },
    ]),
  });
}

function minioFixtureResources({ minioImage, clientImage, credentials }) {
  const namespace = 'ql3-dr';
  assert.notEqual(credentials.writer.accessKey, credentials.recovery.accessKey);
  assert.notEqual(credentials.writer.secretKey, credentials.recovery.secretKey);
  const writerPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetBucketLocation',
          's3:GetBucketVersioning',
          's3:GetObjectLockConfiguration',
          's3:ListBucket',
          's3:ListBucketMultipartUploads',
          's3:ListBucketVersions',
        ],
        Resource: ['arn:aws:s3:::ql3-dr'],
      },
      {
        Effect: 'Allow',
        Action: [
          's3:AbortMultipartUpload',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListMultipartUploadParts',
          's3:PutObject',
        ],
        Resource: ['arn:aws:s3:::ql3-dr/*'],
      },
    ],
  });
  const recoveryPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetBucketLocation',
          's3:GetBucketVersioning',
          's3:GetObjectLockConfiguration',
          's3:ListBucket',
          's3:ListBucketVersions',
        ],
        Resource: ['arn:aws:s3:::ql3-dr'],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: ['arn:aws:s3:::ql3-dr/*'],
      },
    ],
  });
  const credentialEnv = (name, secretName, key) => ({
    name,
    valueFrom: { secretKeyRef: { name: secretName, key } },
  });
  const clientEnvironment = [
    { name: 'MC_CONFIG_DIR', value: '/tmp/mc' },
    { name: 'SSL_CERT_FILE', value: '/certs/ca.crt' },
    credentialEnv('MINIO_ROOT_USER', 'ql3-minio-root', 'ACCESS_KEY_ID'),
    credentialEnv('MINIO_ROOT_PASSWORD', 'ql3-minio-root', 'ACCESS_SECRET_KEY'),
    credentialEnv(
      'WRITER_ACCESS_KEY',
      'ql3-object-store-writer',
      'ACCESS_KEY_ID',
    ),
    credentialEnv(
      'WRITER_SECRET_KEY',
      'ql3-object-store-writer',
      'ACCESS_SECRET_KEY',
    ),
    credentialEnv(
      'RECOVERY_ACCESS_KEY',
      'ql3-object-store-recovery',
      'ACCESS_KEY_ID',
    ),
    credentialEnv(
      'RECOVERY_SECRET_KEY',
      'ql3-object-store-recovery',
      'ACCESS_SECRET_KEY',
    ),
  ];
  const clientVolumes = [
    {
      name: 'ca',
      secret: {
        secretName: 'ql3-minio-ca',
        items: [{ key: 'tls.crt', path: 'ca.crt' }],
      },
    },
    { name: 'tmp', emptyDir: {} },
  ];
  const clientMounts = [
    { name: 'ca', mountPath: '/certs', readOnly: true },
    { name: 'tmp', mountPath: '/tmp' },
  ];
  const clientSecurityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  };
  const bootstrapScript = `set -eu
until mc alias set ql3 https://ql3-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --api S3v4 --path on >/dev/null 2>&1; do sleep 2; done
mc mb --with-lock --ignore-existing ql3/ql3-dr >/dev/null
mc retention set --default governance 30d ql3/ql3-dr/ >/dev/null
mc ilm rule add --expire-days 45 --noncurrent-expire-days 45 ql3/ql3-dr/ >/dev/null
printf '%s' '${writerPolicy}' > /tmp/writer-policy.json
printf '%s' '${recoveryPolicy}' > /tmp/recovery-policy.json
mc admin policy create ql3 ql3-writer /tmp/writer-policy.json >/dev/null
mc admin user add ql3 "$WRITER_ACCESS_KEY" "$WRITER_SECRET_KEY" >/dev/null
mc admin policy attach ql3 ql3-writer --user "$WRITER_ACCESS_KEY" >/dev/null
mc admin policy create ql3 ql3-recovery /tmp/recovery-policy.json >/dev/null
mc admin user add ql3 "$RECOVERY_ACCESS_KEY" "$RECOVERY_SECRET_KEY" >/dev/null
mc admin policy attach ql3 ql3-recovery --user "$RECOVERY_ACCESS_KEY" >/dev/null
mc alias set writer https://ql3-minio:9000 "$WRITER_ACCESS_KEY" "$WRITER_SECRET_KEY" --api S3v4 --path on >/dev/null
printf 'ql3-object-store-authority\n' > /tmp/probe
mc cp /tmp/probe writer/ql3-dr/authority/probe >/dev/null
mc version info ql3/ql3-dr >/dev/null
mc retention info ql3/ql3-dr/ >/dev/null
mc ilm rule ls ql3/ql3-dr/ >/dev/null
echo QL3_MINIO_AUTHORITY_READY`;
  const verifierScript = `set -eu
mc alias set recovery https://ql3-minio:9000 "$RECOVERY_ACCESS_KEY" "$RECOVERY_SECRET_KEY" --api S3v4 --path on >/dev/null
mc cat recovery/ql3-dr/authority/probe > /tmp/readback
grep -qx ql3-object-store-authority /tmp/readback
printf 'unauthorized\n' > /tmp/unauthorized
if mc cp /tmp/unauthorized recovery/ql3-dr/authority/unauthorized >/dev/null 2>&1; then exit 51; fi
if mc rm recovery/ql3-dr/authority/probe >/dev/null 2>&1; then exit 52; fi
mc ls recovery/ql3-dr/ >/dev/null
echo QL3_RECOVERY_READ_ONLY_READY`;
  const job = (name, script, backoffLimit) => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { namespace, name },
    spec: {
      backoffLimit,
      template: {
        metadata: { labels: { app: name } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { fsGroup: 1000 },
          containers: [
            {
              name: 'mc',
              image: clientImage,
              imagePullPolicy: 'IfNotPresent',
              command: ['/bin/sh', '-ec', script],
              env: clientEnvironment,
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '250m', memory: '128Mi' },
              },
              securityContext: clientSecurityContext,
              volumeMounts: clientMounts,
            },
          ],
          volumes: clientVolumes,
        },
      },
    },
  });
  const items = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace },
    },
    kubernetesSecret(namespace, 'ql3-minio-root', {
      ACCESS_KEY_ID: credentials.root.accessKey,
      ACCESS_SECRET_KEY: credentials.root.secretKey,
    }),
    kubernetesSecret(namespace, 'ql3-object-store-writer', {
      ACCESS_KEY_ID: credentials.writer.accessKey,
      ACCESS_SECRET_KEY: credentials.writer.secretKey,
    }),
    kubernetesSecret(namespace, 'ql3-object-store-recovery', {
      ACCESS_KEY_ID: credentials.recovery.accessKey,
      ACCESS_SECRET_KEY: credentials.recovery.secretKey,
    }),
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      metadata: { namespace, name: 'ql3-minio-selfsigned' },
      spec: { selfSigned: {} },
    },
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { namespace, name: 'ql3-minio-ca' },
      spec: {
        isCA: true,
        commonName: 'ql3-minio-ca',
        secretName: 'ql3-minio-ca',
        duration: '24h',
        renewBefore: '1h',
        issuerRef: { name: 'ql3-minio-selfsigned', kind: 'Issuer' },
      },
    },
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      metadata: { namespace, name: 'ql3-minio-ca' },
      spec: { ca: { secretName: 'ql3-minio-ca' } },
    },
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { namespace, name: 'ql3-minio-server' },
      spec: {
        secretName: 'ql3-minio-tls',
        duration: '12h',
        renewBefore: '1h',
        issuerRef: { name: 'ql3-minio-ca', kind: 'Issuer' },
        dnsNames: [
          'ql3-minio',
          'ql3-minio.ql3-dr',
          'ql3-minio.ql3-dr.svc',
          'ql3-minio.ql3-dr.svc.cluster.local',
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { namespace, name: 'ql3-minio-data' },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'local-path',
        resources: { requests: { storage: '2Gi' } },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { namespace, name: 'ql3-minio' },
      spec: {
        selector: { app: 'ql3-minio' },
        ports: [
          { name: 'api', port: 9000, targetPort: 9000 },
          { name: 'console', port: 9001, targetPort: 9001 },
        ],
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { namespace, name: 'ql3-minio' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'ql3-minio' } },
        template: {
          metadata: { labels: { app: 'ql3-minio' } },
          spec: {
            securityContext: {
              fsGroup: 1000,
              fsGroupChangePolicy: 'OnRootMismatch',
            },
            containers: [
              {
                name: 'minio',
                image: minioImage,
                imagePullPolicy: 'IfNotPresent',
                args: [
                  'server',
                  '--certs-dir',
                  '/certs',
                  '--console-address',
                  ':9001',
                  '/data',
                ],
                env: [
                  { name: 'HOME', value: '/tmp' },
                  credentialEnv(
                    'MINIO_ROOT_USER',
                    'ql3-minio-root',
                    'ACCESS_KEY_ID',
                  ),
                  credentialEnv(
                    'MINIO_ROOT_PASSWORD',
                    'ql3-minio-root',
                    'ACCESS_SECRET_KEY',
                  ),
                ],
                ports: [
                  { name: 'api', containerPort: 9000 },
                  { name: 'console', containerPort: 9001 },
                ],
                readinessProbe: {
                  httpGet: {
                    path: '/minio/health/ready',
                    port: 'api',
                    scheme: 'HTTPS',
                  },
                  periodSeconds: 2,
                  timeoutSeconds: 2,
                  failureThreshold: 30,
                },
                resources: {
                  requests: { cpu: '25m', memory: '128Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
                securityContext: clientSecurityContext,
                volumeMounts: [
                  { name: 'data', mountPath: '/data' },
                  { name: 'certs', mountPath: '/certs', readOnly: true },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              {
                name: 'data',
                persistentVolumeClaim: { claimName: 'ql3-minio-data' },
              },
              {
                name: 'certs',
                secret: {
                  secretName: 'ql3-minio-tls',
                  items: [
                    { key: 'tls.crt', path: 'public.crt' },
                    { key: 'tls.key', path: 'private.key' },
                  ],
                },
              },
              { name: 'tmp', emptyDir: {} },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'barmancloud.cnpg.io/v1',
      kind: 'ObjectStore',
      metadata: { namespace, name: 'ql3-postgres-backup' },
      spec: {
        retentionPolicy: '30d',
        configuration: {
          destinationPath: 's3://ql3-dr/qinglong3/ql3-postgres',
          endpointURL: 'https://ql3-minio.ql3-dr.svc:9000',
          endpointCA: { name: 'ql3-minio-ca', key: 'tls.crt' },
          s3Credentials: {
            accessKeyId: {
              name: 'ql3-object-store-writer',
              key: 'ACCESS_KEY_ID',
            },
            secretAccessKey: {
              name: 'ql3-object-store-writer',
              key: 'ACCESS_SECRET_KEY',
            },
          },
          wal: { compression: 'lz4', encryption: 'AES256', maxParallel: 2 },
          data: { compression: 'lz4', encryption: 'AES256', jobs: 2 },
        },
      },
    },
    {
      apiVersion: 'barmancloud.cnpg.io/v1',
      kind: 'ObjectStore',
      metadata: { namespace, name: 'ql3-postgres-recovery-source' },
      spec: {
        configuration: {
          destinationPath: 's3://ql3-dr/qinglong3/ql3-postgres',
          endpointURL: 'https://ql3-minio.ql3-dr.svc:9000',
          endpointCA: { name: 'ql3-minio-ca', key: 'tls.crt' },
          s3Credentials: {
            accessKeyId: {
              name: 'ql3-object-store-recovery',
              key: 'ACCESS_KEY_ID',
            },
            secretAccessKey: {
              name: 'ql3-object-store-recovery',
              key: 'ACCESS_SECRET_KEY',
            },
          },
        },
      },
    },
    job('ql3-minio-bootstrap', bootstrapScript, 3),
  ];
  return Object.freeze({
    core: Object.freeze({ apiVersion: 'v1', kind: 'List', items }),
    verifier: Object.freeze({
      apiVersion: 'v1',
      kind: 'List',
      items: [job('ql3-minio-recovery-authority', verifierScript, 0)],
    }),
  });
}

function postgresSourceFixtureResources({ postgresImage }) {
  assert.match(
    postgresImage,
    /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/,
  );
  const namespace = 'ql3-dr';
  const clusterName = 'ql3-postgres';
  const pluginName = 'barman-cloud.cloudnative-pg.io';
  const cluster = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: {
      namespace,
      name: clusterName,
      labels: {
        'app.kubernetes.io/name': clusterName,
        'app.kubernetes.io/component': 'database',
        'app.kubernetes.io/part-of': 'qinglong3',
      },
    },
    spec: {
      instances: 3,
      imageName: postgresImage,
      imagePullPolicy: 'IfNotPresent',
      enableSuperuserAccess: false,
      primaryUpdateMethod: 'switchover',
      failoverDelay: 0,
      switchoverDelay: 60,
      smartShutdownTimeout: 60,
      stopDelay: 300,
      bootstrap: {
        initdb: { database: 'qinglong', owner: 'qinglong' },
      },
      plugins: [
        {
          name: pluginName,
          isWALArchiver: true,
          parameters: { barmanObjectName: 'ql3-postgres-backup' },
        },
      ],
      postgresql: {
        parameters: {
          max_connections: '100',
          password_encryption: 'scram-sha-256',
          shared_buffers: '64MB',
          synchronous_commit: 'remote_apply',
        },
        synchronous: {
          method: 'any',
          number: 1,
          dataDurability: 'required',
          failoverQuorum: true,
        },
      },
      affinity: {
        enablePodAntiAffinity: true,
        podAntiAffinityType: 'required',
        topologyKey: 'kubernetes.io/hostname',
      },
      managed: { services: { disabledDefaultServices: ['r', 'ro'] } },
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1', memory: '512Mi' },
      },
      storage: { storageClass: 'local-path', size: '1Gi' },
      walStorage: { storageClass: 'local-path', size: '512Mi' },
    },
  };
  const backup = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Backup',
    metadata: { namespace, name: 'ql3-postgres-base-backup' },
    spec: {
      cluster: { name: clusterName },
      method: 'plugin',
      pluginConfiguration: { name: pluginName },
      target: 'prefer-standby',
    },
  };
  return Object.freeze({
    cluster: Object.freeze(cluster),
    backup: Object.freeze(backup),
  });
}

function postgresRestoreFixtureResources({
  postgresImage,
  clusterName,
  targetTime,
}) {
  assert.match(clusterName, /^ql3-postgres-restore-(?:latest|pitr)$/);
  if (targetTime !== undefined) {
    assert.match(
      targetTime,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    );
    assert.ok(Number.isFinite(Date.parse(targetTime)));
  }
  assert.equal(clusterName.endsWith('-pitr'), targetTime !== undefined);
  const source = postgresSourceFixtureResources({ postgresImage }).cluster;
  const { bootstrap: _bootstrap, plugins: _plugins, ...haSpec } = source.spec;
  const recovery = { source: 'ql3-postgres-origin' };
  if (targetTime !== undefined) {
    recovery.recoveryTarget = { targetTime };
  }
  return Object.freeze({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: {
      namespace: 'ql3-dr',
      name: clusterName,
      labels: {
        'app.kubernetes.io/name': clusterName,
        'app.kubernetes.io/component': 'database-restore-drill',
        'app.kubernetes.io/part-of': 'qinglong3',
      },
    },
    spec: {
      ...haSpec,
      bootstrap: { recovery },
      externalClusters: [
        {
          name: 'ql3-postgres-origin',
          plugin: {
            name: 'barman-cloud.cloudnative-pg.io',
            parameters: {
              barmanObjectName: 'ql3-postgres-recovery-source',
              serverName: 'ql3-postgres',
            },
          },
        },
      ],
    },
  });
}

function podReady(pod) {
  return pod?.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
}

function postgresClusterRuntimeEvidence(cluster, pods) {
  const clusterName = cluster?.metadata?.name;
  assert.match(
    clusterName || '',
    /^ql3-postgres(?:-restore-(?:latest|pitr))?$/,
  );
  assert.ok(Array.isArray(pods));
  const clusterPods = pods.filter(
    (pod) => pod?.metadata?.labels?.['cnpg.io/cluster'] === clusterName,
  );
  const readyPods = clusterPods.filter(podReady);
  const nodes = [...new Set(readyPods.map((pod) => pod.spec?.nodeName))].filter(
    Boolean,
  );
  const primary = cluster?.status?.currentPrimary;
  const ready =
    cluster?.spec?.instances === 3 &&
    Number(cluster?.status?.readyInstances) === 3 &&
    typeof primary === 'string' &&
    readyPods.some((pod) => pod.metadata?.name === primary) &&
    readyPods.length === 3 &&
    nodes.length === 3;
  return Object.freeze({
    ready,
    value: ready
      ? Object.freeze({
          primary,
          pods: Object.freeze(readyPods),
          nodes: Object.freeze(nodes.sort()),
        })
      : undefined,
    fact: `${readyPods.length}/3 ready Pods across ${
      nodes.length
    }/3 nodes; primary=${primary || 'none'}; statusReady=${String(
      cluster?.status?.readyInstances ?? 0,
    )}`,
  });
}

function postgresRestoreApplicationRuntimeEvidence(
  deployment,
  pods,
  clusterName,
) {
  assert.match(clusterName, /^ql3-postgres-restore-(?:latest|pitr)$/);
  assert.ok(Array.isArray(pods));
  const expectedName = `ql3-dr-application-${
    clusterName.endsWith('-latest') ? 'latest' : 'pitr'
  }`;
  const matchingPods = pods.filter(
    (pod) =>
      pod?.metadata?.labels?.['app.kubernetes.io/name'] === expectedName &&
      pod?.metadata?.labels?.['ql3.cloud/restore-cluster'] === clusterName,
  );
  const readyPods = matchingPods.filter(podReady);
  const ready =
    deployment?.metadata?.name === expectedName &&
    deployment?.spec?.replicas === 1 &&
    deployment?.status?.availableReplicas === 1 &&
    deployment?.status?.readyReplicas === 1 &&
    readyPods.length === 1;
  return Object.freeze({
    ready,
    value: ready ? Object.freeze({ pod: readyPods[0] }) : undefined,
    fact: `${String(
      readyPods.length,
    )}/1 ready application Pods; available=${String(
      deployment?.status?.availableReplicas ?? 0,
    )}; readyReplicas=${String(deployment?.status?.readyReplicas ?? 0)}`,
  });
}

function backupRuntimeEvidence(backup) {
  const status = backup?.status || {};
  const phase = String(status.phase || '').toLowerCase();
  const startedAt = status.startedAt;
  const stoppedAt = status.stoppedAt;
  const evidence = Object.freeze({
    method: status.method,
    phase,
    targetPod: status.instanceID?.podName,
    backupId: status.backupId,
    beginWal: status.beginWal,
    endWal: status.endWal,
    startedAt,
    stoppedAt,
  });
  const complete =
    phase === 'completed' &&
    status.method === 'plugin' &&
    /^ql3-postgres-[1-9][0-9]*$/.test(status.instanceID?.podName || '') &&
    typeof status.backupId === 'string' &&
    status.backupId.length > 0 &&
    /^[0-9A-F]{24}$/.test(status.beginWal || '') &&
    /^[0-9A-F]{24}$/.test(status.endWal || '') &&
    Number.isFinite(Date.parse(startedAt)) &&
    Number.isFinite(Date.parse(stoppedAt)) &&
    Date.parse(stoppedAt) >= Date.parse(startedAt);
  return Object.freeze({
    ready: complete,
    value: complete ? evidence : undefined,
    fact: `phase=${phase || 'missing'} method=${
      status.method || 'missing'
    } backupId=${
      typeof status.backupId === 'string' && status.backupId.length > 0
        ? 'present'
        : 'missing'
    } beginWal=${status.beginWal || 'missing'} endWal=${
      status.endWal || 'missing'
    }`,
  });
}

function postgresArchiverEvidence(row) {
  const evidence = Object.freeze({
    archivedCount: Number(row?.archivedCount),
    failedCount: Number(row?.failedCount),
    lastArchivedWal: row?.lastArchivedWal,
    lastArchivedTime: row?.lastArchivedTime,
  });
  assert.ok(Number.isSafeInteger(evidence.archivedCount));
  assert.ok(evidence.archivedCount >= 1);
  assert.equal(evidence.failedCount, 0);
  assert.match(evidence.lastArchivedWal || '', /^[0-9A-F]{24}$/);
  assert.ok(Number.isFinite(Date.parse(evidence.lastArchivedTime)));
  return evidence;
}

function postgresSql(kubectl, namespace, podName, sql) {
  assert.match(namespace, /^[a-z0-9][a-z0-9-]*$/);
  assert.match(
    podName,
    /^ql3-postgres(?:-restore-(?:latest|pitr))?-[1-9][0-9]*$/,
  );
  assert.equal(typeof sql, 'string');
  assert.ok(sql.length > 0 && !sql.includes('\0'));
  return kubectl(
    [
      '-n',
      namespace,
      'exec',
      podName,
      '-c',
      'postgres',
      '--',
      'psql',
      '--username',
      'postgres',
      '--dbname',
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

function postgresQueryJson(kubectl, namespace, podName, sql) {
  const output = postgresSql(kubectl, namespace, podName, sql);
  assert.ok(output.length > 0, 'PostgreSQL JSON query returned no rows');
  return JSON.parse(output);
}

function restoreMarkerEvidence(row, expectedAfterMarker) {
  assert.equal(typeof row?.beforeMarkerPresent, 'boolean');
  assert.equal(typeof row?.afterMarkerPresent, 'boolean');
  assert.equal(row.beforeMarkerPresent, true);
  assert.equal(row.afterMarkerPresent, expectedAfterMarker);
  return Object.freeze({
    beforeMarkerPresent: row.beforeMarkerPresent,
    afterMarkerPresent: row.afterMarkerPresent,
  });
}

function postgresMarkerEvidence(row) {
  assert.match(
    row?.id || '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(
    row?.createdAt || '',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  );
  assert.ok(Number.isFinite(Date.parse(row.createdAt)));
  assert.match(row?.wal || '', /^[0-9A-F]{24}$/);
  return Object.freeze({ id: row.id, createdAt: row.createdAt, wal: row.wal });
}

function auditedCloudNativePgDrEvidence(report) {
  const validation = validateCloudNativePgDrEvidence(report);
  assert.equal(
    validation.compatible,
    true,
    `generated DR evidence is incompatible: ${JSON.stringify(
      validation.findings,
    )}`,
  );
  return Object.freeze(report);
}

function parseEvidenceReportPath(argv) {
  assert.ok(Array.isArray(argv));
  if (argv.length === 0) return undefined;
  assert.equal(
    argv.length,
    1,
    'usage: ql3-cloudnativepg-barman-live-contract [--report=/absolute/path]',
  );
  assert.match(
    argv[0],
    /^--report=\/.{1,4085}$/,
    'report must use --report=/absolute/path',
  );
  const target = argv[0].slice('--report='.length);
  assert.equal(path.isAbsolute(target), true);
  assert.ok(Buffer.byteLength(target, 'utf8') <= 4096);
  assert.notEqual(path.basename(target), '.');
  assert.notEqual(path.basename(target), '..');
  return path.normalize(target);
}

function preflightPrivateEvidenceReportPath(target) {
  assert.equal(path.isAbsolute(target), true);
  const directory = fs.realpathSync(path.dirname(target));
  const directoryStat = fs.lstatSync(directory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
  const publishedTarget = path.join(directory, path.basename(target));
  try {
    fs.lstatSync(publishedTarget);
  } catch (error) {
    if (error?.code === 'ENOENT') return publishedTarget;
    throw error;
  }
  throw new Error('refusing to overwrite an existing DR evidence report');
}

function writePrivateEvidenceReport(target, report) {
  assert.equal(path.isAbsolute(target), true);
  const directory = fs.realpathSync(path.dirname(target));
  const directoryStat = fs.lstatSync(directory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
  const publishedTarget = path.join(directory, path.basename(target));
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`, 'utf8');
  assert.ok(bytes.length >= 2 && bytes.length <= 1024 * 1024);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}-${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, publishedTarget);
    fs.unlinkSync(temporary);
    const published = fs.lstatSync(publishedTarget);
    assert.ok(published.isFile() && !published.isSymbolicLink());
    assert.equal(published.size, bytes.length);
    assert.equal(published.mode & 0o077, 0);
    return Object.freeze({
      path: publishedTarget,
      bytes: published.size,
      sha256: `sha256:${sha256(bytes)}`,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function postgresRoleEvidence(rows) {
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((role) => role?.name),
    POSTGRES_ROLE_NAMES,
  );
  return Object.freeze(
    rows.map((role) => {
      assert.equal(role.login, true);
      for (const attribute of [
        'superuser',
        'createdb',
        'createrole',
        'replication',
        'bypassrls',
      ]) {
        assert.equal(role[attribute], false, `${role.name}.${attribute}`);
      }
      return Object.freeze({
        name: role.name,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
      });
    }),
  );
}

function postgresDatabaseContractEvidence(row) {
  const migrationCount = Number(row?.migrationCount);
  const controlCoreCapability = Number(row?.controlCoreCapability);
  const postgresVersionNumber = Number(row?.postgresVersionNumber);
  assert.equal(migrationCount, 52);
  assert.equal(controlCoreCapability, 51);
  assert.equal(row?.databaseOwner, 'ql3_migration');
  assert.equal(postgresVersionNumber, 180004);
  return Object.freeze({
    migrationCount,
    controlCoreCapability,
    databaseOwner: row.databaseOwner,
    postgresVersionNumber,
    roles: postgresRoleEvidence(row.roles),
  });
}

function certificateEvidence(secret) {
  const encoded = secret?.data?.['tls.crt'];
  assert.equal(typeof encoded, 'string');
  const certificate = new crypto.X509Certificate(
    Buffer.from(encoded, 'base64'),
  );
  return Object.freeze({
    serialSha256: `sha256:${sha256(
      Buffer.from(certificate.serialNumber, 'ascii'),
    )}`,
    subjectSha256: `sha256:${sha256(Buffer.from(certificate.subject, 'utf8'))}`,
    subjectAltNameSha256: `sha256:${sha256(
      Buffer.from(certificate.subjectAltName || '', 'utf8'),
    )}`,
    resourceVersion: secret.metadata.resourceVersion,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
  });
}

function certificateRotationEvidence(
  previous,
  current,
  previousRevision,
  currentRevision,
) {
  assert.match(previous?.serialSha256 || '', /^sha256:[a-f0-9]{64}$/);
  assert.match(current?.serialSha256 || '', /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(previous.serialSha256, current.serialSha256);
  assert.equal(typeof previous.resourceVersion, 'string');
  assert.equal(typeof current.resourceVersion, 'string');
  assert.notEqual(previous.resourceVersion, current.resourceVersion);
  assert.ok(Number.isSafeInteger(previousRevision) && previousRevision >= 1);
  assert.ok(
    Number.isSafeInteger(currentRevision) && currentRevision > previousRevision,
  );
  return Object.freeze({
    previousSerialSha256: previous.serialSha256,
    currentSerialSha256: current.serialSha256,
    previousSecretResourceVersion: previous.resourceVersion,
    currentSecretResourceVersion: current.resourceVersion,
  });
}

function webhookConfigurationHasCaBundle(configuration) {
  const webhooks = configuration?.webhooks;
  return (
    Array.isArray(webhooks) &&
    webhooks.length > 0 &&
    webhooks.every((webhook) => {
      const caBundle = webhook?.clientConfig?.caBundle;
      return (
        typeof caBundle === 'string' &&
        caBundle.length > 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(caBundle) &&
        Buffer.from(caBundle, 'base64').length > 0
      );
    })
  );
}

async function main(argv = process.argv.slice(2)) {
  const requestedEvidenceReportPath = parseEvidenceReportPath(argv);
  const evidenceReportPath =
    requestedEvidenceReportPath === undefined
      ? undefined
      : preflightPrivateEvidenceReportPath(requestedEvidenceReportPath);
  if (process.env.QL3_CLOUDNATIVEPG_BARMAN_LIVE !== '1') {
    throw new Error(
      'Refusing Docker/Kubernetes mutation without QL3_CLOUDNATIVEPG_BARMAN_LIVE=1',
    );
  }
  const sourceRevision = process.env.QL3_SOURCE_REVISION;
  assert.match(
    sourceRevision || '',
    /^[a-f0-9]{40,64}$/,
    'QL3_SOURCE_REVISION must bind the exact source commit',
  );
  assertCloudNativePgDrRunnerCapacity();

  const docker = process.env.QL3_DOCKER_BIN || 'docker';
  const kubectlBinary = process.env.QL3_KUBECTL_BIN || 'kubectl';
  const curl = process.env.QL3_CURL_BIN || 'curl';
  const suffix = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const prefix = `ql3-barman-dr-${suffix}`;
  assert.match(prefix, /^ql3-barman-dr-[0-9]+-[a-f0-9]{6}$/);
  const dockerLabels = [
    '--label',
    DOCKER_SCOPE_LABEL,
    '--label',
    `${DOCKER_RUN_LABEL_KEY}=${prefix}`,
  ];
  const network = `${prefix}-network`;
  const registry = `${prefix}-registry`;
  const server = `${prefix}-server`;
  const agents = [
    `${prefix}-agent-a`,
    `${prefix}-agent-b`,
    `${prefix}-agent-c`,
  ];
  const nodes = [server, ...agents];
  const containers = [registry, ...nodes];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-barman-dr-'));
  fs.chmodSync(temporary, 0o700);
  const dockerDataRoot = path.join(temporary, 'docker-data');
  const registryDataBindArgs = privateDockerDataBindArgs(
    dockerDataRoot,
    registry,
    REGISTRY_DATA_TARGETS,
  );
  const nodeDataBindArgs = new Map(
    nodes.map((node) => [
      node,
      privateDockerDataBindArgs(dockerDataRoot, node, K3S_DATA_TARGETS),
    ]),
  );
  const kubeconfig = path.join(temporary, 'kubeconfig');
  const registriesConfig = path.join(temporary, 'registries.yaml');
  const noProxy = [
    registry,
    'localhost',
    '127.0.0.1',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '.svc',
    '.cluster.local',
  ].join(',');
  fs.writeFileSync(
    registriesConfig,
    `mirrors:\n  "${registry}:5000":\n    endpoint:\n      - "http://${registry}:5000"\n`,
    { mode: 0o600, flag: 'wx' },
  );
  let certManagerManifest;
  let barmanManifest;
  let cnpgManifest;
  let clusterControlImage;

  const clusterToken = crypto.randomBytes(32).toString('base64url');
  const createdContainers = new Set();
  const builtImages = new Set();
  let networkCreated = false;
  const keep = process.env.QL3_KEEP_BARMAN_DR_CLUSTER === '1';
  try {
    const certManagerSource = manifestSource(
      'QL3_CERT_MANAGER_MANIFEST_FILE',
      '/private/tmp/ql3-cert-manager-v1.20.3-release-manifest.yaml',
      curl,
      path.join(temporary, 'cert-manager-source.yaml'),
      CERT_MANAGER_MANIFEST_URL,
    );
    const barmanSource = manifestSource(
      'QL3_BARMAN_MANIFEST_FILE',
      '/private/tmp/ql3-barman-cloud-v0.13.0-release-manifest.yaml',
      curl,
      path.join(temporary, 'barman-source.yaml'),
      BARMAN_MANIFEST_URL,
    );
    const cnpgSource = manifestSource(
      'QL3_CNPG_OPERATOR_MANIFEST_FILE',
      '',
      curl,
      path.join(temporary, 'cnpg-source.yaml'),
      CNPG_MANIFEST_URL,
    );
    run(docker, ['version'], { capture: true, quiet: true });
    const architecture = normalizeArchitecture(
      run(docker, ['info', '--format', '{{.Architecture}}'], {
        capture: true,
        quiet: true,
      }).stdout,
    );
    const expected = PLATFORM_DIGESTS[architecture];
    assert.ok(expected, `unsupported Docker architecture ${architecture}`);
    const runtimeImages = Object.freeze({
      cnpg: `${registry}:5000/ql3/cloudnative-pg@${expected.cnpg}`,
      barman: `${registry}:5000/ql3/barman-cloud@${expected.barman}`,
      barmanSidecar: `${registry}:5000/ql3/barman-cloud-sidecar@${expected.barmanSidecar}`,
      certManager: `${registry}:5000/ql3/cert-manager-controller@${expected.certManager}`,
      certManagerCainjector: `${registry}:5000/ql3/cert-manager-cainjector@${expected.certManagerCainjector}`,
      certManagerWebhook: `${registry}:5000/ql3/cert-manager-webhook@${expected.certManagerWebhook}`,
      minio: `${registry}:5000/ql3/minio@${expected.minio}`,
      minioClient: `${registry}:5000/ql3/minio-client@${expected.minioClient}`,
      postgres: `${registry}:5000/ql3/postgresql@${expected.postgres}`,
    });
    certManagerManifest = reviewedManifest(
      certManagerSource,
      path.join(temporary, 'cert-manager-pinned.yaml'),
      CERT_MANAGER_MANIFEST_SHA256,
      [
        [
          'quay.io/jetstack/cert-manager-controller:v1.20.3',
          runtimeImages.certManager,
        ],
        [
          'quay.io/jetstack/cert-manager-cainjector:v1.20.3',
          runtimeImages.certManagerCainjector,
        ],
        [
          'quay.io/jetstack/cert-manager-webhook:v1.20.3',
          runtimeImages.certManagerWebhook,
        ],
      ],
    );
    barmanManifest = reviewedManifest(
      barmanSource,
      path.join(temporary, 'barman-pinned.yaml'),
      BARMAN_MANIFEST_SHA256,
      [
        [
          'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0',
          runtimeImages.barman,
        ],
        [
          '    Z2hjci5pby9jbG91ZG5hdGl2ZS1wZy9wbHVnaW4tYmFybWFuLWNsb3VkLXNpZGVjYXI6dj\n    AuMTMuMA==',
          `    ${Buffer.from(runtimeImages.barmanSidecar).toString('base64')}`,
        ],
      ],
    );
    cnpgManifest = reviewedManifest(
      cnpgSource,
      path.join(temporary, 'cnpg-pinned.yaml'),
      CNPG_MANIFEST_SHA256,
      [
        ['ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0', runtimeImages.cnpg, 2],
        [
          '        imagePullPolicy: Always',
          '        imagePullPolicy: IfNotPresent',
        ],
      ],
    );

    for (const container of containers) {
      assert.equal(
        run(docker, ['inspect', container], {
          capture: true,
          quiet: true,
          allowFailure: true,
        }).status,
        1,
        `refusing to reuse Docker container ${container}`,
      );
    }
    assert.equal(
      run(docker, ['network', 'inspect', network], {
        capture: true,
        quiet: true,
        allowFailure: true,
      }).status,
      1,
      `refusing to reuse Docker network ${network}`,
    );

    run(docker, ['network', 'create', ...dockerLabels, network], {
      capture: true,
      quiet: true,
    });
    networkCreated = true;
    run(
      docker,
      [
        'run',
        '-d',
        '--network',
        network,
        ...dockerLabels,
        '--name',
        registry,
        '-p',
        '127.0.0.1::5000',
        ...registryDataBindArgs,
        REGISTRY_IMAGE,
      ],
      { capture: true, quiet: true },
    );
    createdContainers.add(registry);
    const registryPort = run(docker, ['port', registry, '5000/tcp'], {
      capture: true,
      quiet: true,
    }).stdout;
    assert.match(registryPort, /^127\.0\.0\.1:\d+$/);
    await waitFor('local OCI registry readiness', 60_000, () => {
      const result = run(
        curl,
        ['--fail', '--silent', `http://${registryPort}/v2/`],
        {
          capture: true,
          quiet: true,
          allowFailure: true,
        },
      );
      return result.status === 0 && result.stdout === '{}'
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    const clusterControlLocalTag = `${registryPort}/ql3/cluster-control:dr-${suffix}`;
    builtImages.add(clusterControlLocalTag);
    clusterControlImage = buildClusterControlImage({
      docker,
      registry,
      registryPort,
      architecture,
      suffix,
    });
    assert.equal(clusterControlImage.localTag, clusterControlLocalTag);
    run(
      docker,
      [
        'run',
        '-d',
        '--privileged',
        '--network',
        network,
        ...dockerLabels,
        '--name',
        server,
        '--env',
        `NO_PROXY=${noProxy}`,
        '--env',
        `no_proxy=${noProxy}`,
        '--volume',
        `${registriesConfig}:/etc/rancher/k3s/registries.yaml:ro`,
        ...nodeDataBindArgs.get(server),
        '-p',
        '127.0.0.1::6443',
        K3S_IMAGE,
        'server',
        '--token',
        clusterToken,
        '--node-name',
        server,
        '--disable=traefik',
        '--disable=servicelb',
        '--kubelet-arg',
        `eviction-hard=${K3S_EVICTION_HARD}`,
        '--write-kubeconfig-mode=600',
        '--tls-san=127.0.0.1',
      ],
      { capture: true, quiet: true },
    );
    createdContainers.add(server);
    await waitFor('K3s API readiness', 180_000, () => {
      const result = run(
        docker,
        ['exec', server, 'kubectl', 'get', '--raw=/readyz'],
        { capture: true, quiet: true, allowFailure: true },
      );
      return result.status === 0 && result.stdout === 'ok'
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });

    for (const agent of agents) {
      run(
        docker,
        [
          'run',
          '-d',
          '--privileged',
          '--network',
          network,
          ...dockerLabels,
          '--name',
          agent,
          '--env',
          `NO_PROXY=${noProxy}`,
          '--env',
          `no_proxy=${noProxy}`,
          '--volume',
          `${registriesConfig}:/etc/rancher/k3s/registries.yaml:ro`,
          ...nodeDataBindArgs.get(agent),
          K3S_IMAGE,
          'agent',
          '--server',
          `https://${server}:6443`,
          '--token',
          clusterToken,
          '--node-name',
          agent,
          '--kubelet-arg',
          `eviction-hard=${K3S_EVICTION_HARD}`,
        ],
        { capture: true, quiet: true },
      );
      createdContainers.add(agent);
    }

    const port = run(docker, ['port', server, '6443/tcp'], {
      capture: true,
      quiet: true,
    }).stdout;
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    const config = run(
      docker,
      ['exec', server, 'cat', '/etc/rancher/k3s/k3s.yaml'],
      { capture: true, quiet: true },
    ).stdout.replace('https://127.0.0.1:6443', `https://${port}`);
    fs.writeFileSync(kubeconfig, `${config}\n`, { mode: 0o600, flag: 'wx' });

    const kubectl = (args, options = {}) =>
      run(kubectlBinary, ['--kubeconfig', kubeconfig, ...args], options);
    const kubectlJson = (args) =>
      JSON.parse(
        kubectl([...args, '-o', 'json'], {
          capture: true,
          quiet: true,
        }).stdout,
      );

    const nodesReady = await waitFor('four K3s nodes', 240_000, () => {
      const nodes = kubectlJson(['get', 'nodes']).items || [];
      const ready = nodes.filter((node) =>
        node.status.conditions?.some(
          (condition) =>
            condition.type === 'Ready' && condition.status === 'True',
        ),
      );
      return ready.length === 4
        ? { ready: true, value: ready }
        : { ready: false, fact: `${ready.length}/4 Ready nodes` };
    });
    const versions = new Set(
      nodesReady.value.map((node) => node.status.nodeInfo.kubeletVersion),
    );
    assert.equal(versions.size, 1);
    assert.match([...versions][0], /^v1\.32\.8\+k3s1$/);

    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.certManager,
        'cert-manager-controller',
        architecture,
        expected.certManager,
      ),
      runtimeImages.certManager,
    );
    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.certManagerCainjector,
        'cert-manager-cainjector',
        architecture,
        expected.certManagerCainjector,
      ),
      runtimeImages.certManagerCainjector,
    );
    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.certManagerWebhook,
        'cert-manager-webhook',
        architecture,
        expected.certManagerWebhook,
      ),
      runtimeImages.certManagerWebhook,
    );
    kubectl(['apply', '--server-side', '-f', certManagerManifest.target]);
    kubectl([
      'wait',
      '--for=condition=Established',
      'crd/certificates.cert-manager.io',
      'crd/issuers.cert-manager.io',
      '--timeout=5m',
    ]);
    for (const deployment of [
      'cert-manager',
      'cert-manager-cainjector',
      'cert-manager-webhook',
    ]) {
      kubectl([
        '-n',
        'cert-manager',
        'rollout',
        'status',
        `deployment/${deployment}`,
        '--timeout=10m',
      ]);
    }
    await waitFor('cert-manager webhook CA injection', 300_000, () => {
      const configurations = [
        kubectlJson([
          'get',
          'mutatingwebhookconfiguration',
          'cert-manager-webhook',
        ]),
        kubectlJson([
          'get',
          'validatingwebhookconfiguration',
          'cert-manager-webhook',
        ]),
      ];
      const ready = configurations.filter(webhookConfigurationHasCaBundle);
      return ready.length === configurations.length
        ? { ready: true, value: ready.length }
        : {
            ready: false,
            fact: `${String(ready.length)}/${String(
              configurations.length,
            )} webhook configurations have CA bundles`,
          };
    });

    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.cnpg,
        'cloudnative-pg',
        architecture,
        expected.cnpg,
      ),
      runtimeImages.cnpg,
    );
    kubectl(['apply', '--server-side', '-f', cnpgManifest.target]);
    kubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusters.postgresql.cnpg.io',
      '--timeout=5m',
    ]);
    kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '--timeout=10m',
    ]);

    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.barman,
        'barman-cloud',
        architecture,
        expected.barman,
      ),
      runtimeImages.barman,
    );
    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.barmanSidecar,
        'barman-cloud-sidecar',
        architecture,
        expected.barmanSidecar,
      ),
      runtimeImages.barmanSidecar,
    );
    kubectl(['apply', '--server-side', '-f', barmanManifest.target]);
    kubectl([
      'wait',
      '--for=condition=Established',
      'crd/objectstores.barmancloud.cnpg.io',
      '--timeout=5m',
    ]);
    kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/barman-cloud',
      '--timeout=10m',
    ]);
    kubectl([
      '-n',
      'cnpg-system',
      'wait',
      '--for=condition=Ready',
      'certificate/barman-cloud-client',
      'certificate/barman-cloud-server',
      '--timeout=5m',
    ]);

    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.postgres,
        'postgresql',
        architecture,
        expected.postgres,
      ),
      runtimeImages.postgres,
    );
    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.minio,
        'minio',
        architecture,
        expected.minio,
      ),
      runtimeImages.minio,
    );
    assert.equal(
      mirrorPlatformImage(
        docker,
        registry,
        IMAGES.minioClient,
        'minio-client',
        architecture,
        expected.minioClient,
      ),
      runtimeImages.minioClient,
    );
    const minioCredentials = Object.freeze({
      root: Object.freeze({
        accessKey: `QL3ROOT${crypto
          .randomBytes(4)
          .toString('hex')
          .toUpperCase()}`,
        secretKey: crypto.randomBytes(32).toString('base64url'),
      }),
      writer: Object.freeze({
        accessKey: `QL3W${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        secretKey: crypto.randomBytes(32).toString('base64url'),
      }),
      recovery: Object.freeze({
        accessKey: `QL3R${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        secretKey: crypto.randomBytes(32).toString('base64url'),
      }),
    });
    const minioFixture = minioFixtureResources({
      minioImage: runtimeImages.minio,
      clientImage: runtimeImages.minioClient,
      credentials: minioCredentials,
    });
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(minioFixture.core)}\n`,
    });
    kubectl([
      '-n',
      'ql3-dr',
      'wait',
      '--for=condition=Ready',
      'certificate/ql3-minio-ca',
      'certificate/ql3-minio-server',
      '--timeout=5m',
    ]);
    kubectl([
      '-n',
      'ql3-dr',
      'rollout',
      'status',
      'deployment/ql3-minio',
      '--timeout=10m',
    ]);
    kubectl([
      '-n',
      'ql3-dr',
      'wait',
      '--for=condition=Complete',
      'job/ql3-minio-bootstrap',
      '--timeout=10m',
    ]);
    const bootstrapLog = kubectl(
      ['-n', 'ql3-dr', 'logs', 'job/ql3-minio-bootstrap'],
      { capture: true, quiet: true },
    ).stdout;
    assert.match(bootstrapLog, /(?:^|\n)QL3_MINIO_AUTHORITY_READY(?:\n|$)/);
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(minioFixture.verifier)}\n`,
    });
    kubectl([
      '-n',
      'ql3-dr',
      'wait',
      '--for=condition=Complete',
      'job/ql3-minio-recovery-authority',
      '--timeout=5m',
    ]);
    const recoveryAuthorityLog = kubectl(
      ['-n', 'ql3-dr', 'logs', 'job/ql3-minio-recovery-authority'],
      { capture: true, quiet: true },
    ).stdout;
    assert.match(
      recoveryAuthorityLog,
      /(?:^|\n)QL3_RECOVERY_READ_ONLY_READY(?:\n|$)/,
    );
    const writerObjectStore = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'objectstore/ql3-postgres-backup',
    ]);
    const recoveryObjectStore = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'objectstore/ql3-postgres-recovery-source',
    ]);
    assert.equal(writerObjectStore.spec.retentionPolicy, '30d');
    assert.equal(
      writerObjectStore.spec.configuration.s3Credentials.accessKeyId.name,
      'ql3-object-store-writer',
    );
    assert.equal(
      recoveryObjectStore.spec.configuration.s3Credentials.accessKeyId.name,
      'ql3-object-store-recovery',
    );
    assert.equal(recoveryObjectStore.spec.configuration.serverName, undefined);
    assert.equal(
      writerObjectStore.spec.configuration.endpointURL,
      'https://ql3-minio.ql3-dr.svc:9000',
    );

    const sourceFixture = postgresSourceFixtureResources({
      postgresImage: runtimeImages.postgres,
    });
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(sourceFixture.cluster)}\n`,
    });
    const sourceReady = await waitFor(
      'three-node PostgreSQL source cluster',
      15 * 60_000,
      () =>
        postgresClusterRuntimeEvidence(
          kubectlJson(['-n', 'ql3-dr', 'get', 'cluster/ql3-postgres']),
          kubectlJson([
            '-n',
            'ql3-dr',
            'get',
            'pods',
            '-l',
            'cnpg.io/cluster=ql3-postgres',
          ]).items,
        ),
    );
    const sourcePrimary = sourceReady.value.primary;
    const sourcePostgresImages = sourceReady.value.pods.map((pod) =>
      runtimeImageEvidence(pod, 'postgres', IMAGES.postgres, expected.postgres),
    );
    const sourceBarmanSidecarImages = sourceReady.value.pods.map((pod) =>
      runtimeImageEvidence(
        pod,
        'plugin-barman-cloud',
        IMAGES.barmanSidecar,
        expected.barmanSidecar,
      ),
    );
    assert.ok(clusterControlImage);
    const postgresRoleCredentials = Object.freeze(
      Object.fromEntries(
        POSTGRES_ROLE_NAMES.map((role) => [
          role,
          crypto.randomBytes(32).toString('base64url'),
        ]),
      ),
    );
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(
        postgresRoleSecretResources(postgresRoleCredentials),
      )}\n`,
    });
    kubectl(['-n', 'ql3-dr', 'apply', '-f', POSTGRES_DATABASE_ROLE_MANIFEST]);
    const roleNamesSql = POSTGRES_ROLE_NAMES.map((role) => `'${role}'`).join(
      ', ',
    );
    const roleCatalogSql = `SELECT json_build_object(
      'roles', COALESCE((
        SELECT json_agg(json_build_object(
          'name', rolname,
          'login', rolcanlogin,
          'superuser', rolsuper,
          'createdb', rolcreatedb,
          'createrole', rolcreaterole,
          'replication', rolreplication,
          'bypassrls', rolbypassrls
        ) ORDER BY rolname)
        FROM pg_roles
        WHERE rolname IN (${roleNamesSql})
      ), '[]'::json)
    )::text`;
    const sourceRoles = await waitFor(
      'thirteen reconciled PostgreSQL database roles',
      10 * 60_000,
      () => {
        try {
          const value = postgresRoleEvidence(
            postgresQueryJson(kubectl, 'ql3-dr', sourcePrimary, roleCatalogSql)
              .roles,
          );
          return { ready: true, value };
        } catch (error) {
          return {
            ready: false,
            fact: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    assert.equal(sourceRoles.value.length, 13);
    postgresSql(
      kubectl,
      'ql3-dr',
      sourcePrimary,
      'ALTER DATABASE qinglong OWNER TO ql3_migration',
    );
    const migrationJob = postgresMigrationJobResource({
      controlImage: clusterControlImage.runtimeImage,
    });
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(migrationJob)}\n`,
    });
    kubectl([
      '-n',
      'ql3-dr',
      'wait',
      '--for=condition=Complete',
      'job/ql3-cluster-migration',
      '--timeout=10m',
    ]);
    const migrationLog = kubectl(
      ['-n', 'ql3-dr', 'logs', 'job/ql3-cluster-migration'],
      { capture: true, quiet: true },
    ).stdout;
    assert.match(migrationLog, /"event":"migration_completed"/);
    const migrationPod = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'pods',
      '-l',
      'job-name=ql3-cluster-migration',
    ]).items[0];
    const migrationImage = runtimeImageEvidence(
      migrationPod,
      'migration',
      clusterControlImage.runtimeImage,
      clusterControlImage.platformDigest,
    );
    const databaseContractSql = `SELECT json_build_object(
      'migrationCount', (
        SELECT count(*)::integer FROM ql3.schema_migrations
      ),
      'controlCoreCapability', (
        SELECT contract_version::integer
        FROM ql3.schema_capabilities
        WHERE contract_name = 'control-core'
      ),
      'databaseOwner', (
        SELECT pg_get_userbyid(datdba)
        FROM pg_database
        WHERE datname = current_database()
      ),
      'postgresVersionNumber', current_setting('server_version_num')::integer,
      'roles', COALESCE((
        SELECT json_agg(json_build_object(
          'name', rolname,
          'login', rolcanlogin,
          'superuser', rolsuper,
          'createdb', rolcreatedb,
          'createrole', rolcreaterole,
          'replication', rolreplication,
          'bypassrls', rolbypassrls
        ) ORDER BY rolname)
        FROM pg_roles
        WHERE rolname IN (${roleNamesSql})
      ), '[]'::json)
    )::text`;
    const sourceDatabaseContract = postgresDatabaseContractEvidence(
      postgresQueryJson(kubectl, 'ql3-dr', sourcePrimary, databaseContractSql),
    );
    postgresSql(
      kubectl,
      'ql3-dr',
      sourcePrimary,
      `CREATE TABLE IF NOT EXISTS public.ql3_dr_marker (
         marker_id text PRIMARY KEY,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    const recordMarker = (markerId) =>
      postgresMarkerEvidence(
        postgresQueryJson(
          kubectl,
          'ql3-dr',
          sourcePrimary,
          `WITH inserted AS (
             INSERT INTO public.ql3_dr_marker (marker_id)
             VALUES ('${markerId}')
             RETURNING marker_id, created_at
           )
           SELECT json_build_object(
             'id', marker_id,
             'createdAt', to_char(
               created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ),
             'wal', pg_walfile_name(pg_current_wal_lsn())
           )::text
           FROM inserted`,
        ),
      );
    const beforeMarker = recordMarker(crypto.randomUUID());
    assert.ok(
      Date.parse(beforeMarker.createdAt) <= Date.now(),
      'before marker timestamp is in the future',
    );
    postgresSql(kubectl, 'ql3-dr', sourcePrimary, 'SELECT pg_switch_wal()');
    const archiverSql = `SELECT json_build_object(
      'archivedCount', archived_count::text,
      'failedCount', failed_count::text,
      'lastArchivedWal', last_archived_wal,
      'lastArchivedTime', to_char(
        last_archived_time AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )::text FROM pg_stat_archiver`;
    const walBeforeBackup = await waitFor(
      'continuous WAL archive before base backup',
      10 * 60_000,
      () => ({
        ready: true,
        value: postgresArchiverEvidence(
          postgresQueryJson(kubectl, 'ql3-dr', sourcePrimary, archiverSql),
        ),
      }),
    );
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(sourceFixture.backup)}\n`,
    });
    const baseBackup = await waitFor(
      'plugin base backup completion',
      15 * 60_000,
      () =>
        backupRuntimeEvidence(
          kubectlJson([
            '-n',
            'ql3-dr',
            'get',
            'backup/ql3-postgres-base-backup',
          ]),
        ),
    );
    assert.notEqual(
      baseBackup.value.targetPod,
      sourcePrimary,
      'prefer-standby backup unexpectedly ran on the primary',
    );
    const pitrTarget = postgresQueryJson(
      kubectl,
      'ql3-dr',
      sourcePrimary,
      `SELECT json_build_object(
        'targetTime', to_char(
          clock_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      )::text`,
    ).targetTime;
    assert.match(pitrTarget, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const afterMarker = recordMarker(crypto.randomUUID());
    assert.notEqual(beforeMarker.id, afterMarker.id);
    assert.ok(
      Date.parse(beforeMarker.createdAt) < Date.parse(afterMarker.createdAt),
      'DR markers must be strictly ordered',
    );
    assert.ok(
      Date.parse(beforeMarker.createdAt) < Date.parse(pitrTarget) &&
        Date.parse(pitrTarget) < Date.parse(afterMarker.createdAt),
      'PITR target must be strictly between DR markers',
    );
    postgresSql(kubectl, 'ql3-dr', sourcePrimary, 'SELECT pg_switch_wal()');
    const walAfterTarget = await waitFor(
      'continuous WAL archive after PITR boundary',
      10 * 60_000,
      () => {
        const evidence = postgresArchiverEvidence(
          postgresQueryJson(kubectl, 'ql3-dr', sourcePrimary, archiverSql),
        );
        return {
          ready:
            evidence.archivedCount > walBeforeBackup.value.archivedCount &&
            evidence.lastArchivedWal !== walBeforeBackup.value.lastArchivedWal,
          value: evidence,
          fact: `archived=${evidence.archivedCount} last=${evidence.lastArchivedWal}`,
        };
      },
    );

    const clientCertificateBefore = kubectlJson([
      '-n',
      'cnpg-system',
      'get',
      'certificate/barman-cloud-client',
    ]);
    const serverCertificateBefore = kubectlJson([
      '-n',
      'cnpg-system',
      'get',
      'certificate/barman-cloud-server',
    ]);
    const clientSecretBefore = kubectlJson([
      '-n',
      'cnpg-system',
      'get',
      'secret/barman-cloud-client-tls',
    ]);
    const serverSecretBefore = kubectlJson([
      '-n',
      'cnpg-system',
      'get',
      'secret/barman-cloud-server-tls',
    ]);
    const clientEvidenceBefore = certificateEvidence(clientSecretBefore);
    const serverEvidenceBefore = certificateEvidence(serverSecretBefore);
    const clientRevisionBefore = Number(
      clientCertificateBefore.status?.revision,
    );
    const serverRevisionBefore = Number(
      serverCertificateBefore.status?.revision,
    );
    assert.ok(clientRevisionBefore >= 1 && serverRevisionBefore >= 1);
    const rotationPatch = JSON.stringify({
      spec: {
        duration: '24h',
        renewBefore: '1h',
        privateKey: { rotationPolicy: 'Always' },
      },
    });
    for (const certificate of ['barman-cloud-client', 'barman-cloud-server']) {
      kubectl([
        '-n',
        'cnpg-system',
        'patch',
        `certificate/${certificate}`,
        '--type=merge',
        '--patch',
        rotationPatch,
      ]);
    }
    const rotatedCertificates = await waitFor(
      'Barman mutual TLS certificate rotation',
      10 * 60_000,
      () => {
        const clientCertificate = kubectlJson([
          '-n',
          'cnpg-system',
          'get',
          'certificate/barman-cloud-client',
        ]);
        const serverCertificate = kubectlJson([
          '-n',
          'cnpg-system',
          'get',
          'certificate/barman-cloud-server',
        ]);
        const clientSecret = kubectlJson([
          '-n',
          'cnpg-system',
          'get',
          'secret/barman-cloud-client-tls',
        ]);
        const serverSecret = kubectlJson([
          '-n',
          'cnpg-system',
          'get',
          'secret/barman-cloud-server-tls',
        ]);
        const clientEvidence = certificateEvidence(clientSecret);
        const serverEvidence = certificateEvidence(serverSecret);
        const clientRotation = certificateRotationEvidence(
          clientEvidenceBefore,
          clientEvidence,
          clientRevisionBefore,
          Number(clientCertificate.status?.revision),
        );
        const serverRotation = certificateRotationEvidence(
          serverEvidenceBefore,
          serverEvidence,
          serverRevisionBefore,
          Number(serverCertificate.status?.revision),
        );
        return {
          ready: true,
          value: {
            clientSecret,
            serverSecret,
            clientEvidence,
            serverEvidence,
            clientRotation,
            serverRotation,
          },
        };
      },
    );
    const clientSecret = rotatedCertificates.value.clientSecret;
    const serverSecret = rotatedCertificates.value.serverSecret;
    const sourcePrimaryAfterRotation = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'cluster/ql3-postgres',
    ]).status?.currentPrimary;
    assert.match(
      sourcePrimaryAfterRotation || '',
      /^ql3-postgres-[1-9][0-9]*$/,
    );
    postgresSql(
      kubectl,
      'ql3-dr',
      sourcePrimaryAfterRotation,
      'SELECT pg_switch_wal()',
    );
    const walAfterRotation = await waitFor(
      'continuous WAL archive after Barman certificate rotation',
      10 * 60_000,
      () => {
        const evidence = postgresArchiverEvidence(
          postgresQueryJson(
            kubectl,
            'ql3-dr',
            sourcePrimaryAfterRotation,
            archiverSql,
          ),
        );
        return {
          ready:
            evidence.archivedCount > walAfterTarget.value.archivedCount &&
            evidence.lastArchivedWal !== walAfterTarget.value.lastArchivedWal,
          value: evidence,
          fact: `archived=${evidence.archivedCount} last=${evidence.lastArchivedWal}`,
        };
      },
    );
    const postRotationBackupResource = {
      ...sourceFixture.backup,
      metadata: {
        ...sourceFixture.backup.metadata,
        name: 'ql3-postgres-post-rotation-backup',
      },
    };
    kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(postRotationBackupResource)}\n`,
    });
    const postRotationBackup = await waitFor(
      'post-rotation plugin base backup completion',
      15 * 60_000,
      () =>
        backupRuntimeEvidence(
          kubectlJson([
            '-n',
            'ql3-dr',
            'get',
            'backup/ql3-postgres-post-rotation-backup',
          ]),
        ),
    );
    assert.notEqual(
      postRotationBackup.value.targetPod,
      sourcePrimaryAfterRotation,
      'post-rotation prefer-standby backup unexpectedly ran on the primary',
    );
    postgresSql(
      kubectl,
      'ql3-dr',
      sourcePrimaryAfterRotation,
      'SELECT pg_switch_wal()',
    );
    const walBeforeRestores = await waitFor(
      'final continuous WAL archive before recovery drills',
      10 * 60_000,
      () => {
        const evidence = postgresArchiverEvidence(
          postgresQueryJson(
            kubectl,
            'ql3-dr',
            sourcePrimaryAfterRotation,
            archiverSql,
          ),
        );
        return {
          ready:
            evidence.archivedCount > walAfterRotation.value.archivedCount &&
            evidence.lastArchivedWal !== walAfterRotation.value.lastArchivedWal,
          value: evidence,
          fact: `archived=${evidence.archivedCount} last=${evidence.lastArchivedWal}`,
        };
      },
    );
    const observedRpoSeconds = Math.max(
      0,
      (Date.now() - Date.parse(walBeforeRestores.value.lastArchivedTime)) /
        1_000,
    );
    assert.ok(observedRpoSeconds <= 60);

    const sourceClusterBeforeRestores = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'cluster/ql3-postgres',
    ]);
    const sourceUid = sourceClusterBeforeRestores.metadata.uid;
    assert.match(sourceUid || '', /^[0-9a-f-]{36}$/);
    const markerSql = `SELECT json_build_object(
      'beforeMarkerPresent', EXISTS (
        SELECT 1 FROM public.ql3_dr_marker
        WHERE marker_id = '${beforeMarker.id}'
      ),
      'afterMarkerPresent', EXISTS (
        SELECT 1 FROM public.ql3_dr_marker
        WHERE marker_id = '${afterMarker.id}'
      )
    )::text`;
    const restoreCluster = async ({ clusterName, targetTime, expectAfter }) => {
      const restore = postgresRestoreFixtureResources({
        postgresImage: runtimeImages.postgres,
        clusterName,
        targetTime,
      });
      const startedAt = Date.now();
      kubectl(['apply', '-f', '-'], { input: `${JSON.stringify(restore)}\n` });
      const ready = await waitFor(
        `${clusterName} three-node recovery`,
        20 * 60_000,
        () =>
          postgresClusterRuntimeEvidence(
            kubectlJson(['-n', 'ql3-dr', 'get', `cluster/${clusterName}`]),
            kubectlJson([
              '-n',
              'ql3-dr',
              'get',
              'pods',
              '-l',
              `cnpg.io/cluster=${clusterName}`,
            ]).items,
          ),
      );
      const databaseRtoMs = Date.now() - startedAt;
      const observedCluster = kubectlJson([
        '-n',
        'ql3-dr',
        'get',
        `cluster/${clusterName}`,
      ]);
      assert.equal(observedCluster.spec.plugins, undefined);
      assert.deepEqual(
        observedCluster.spec.externalClusters?.[0]?.plugin?.parameters,
        {
          barmanObjectName: 'ql3-postgres-recovery-source',
          serverName: 'ql3-postgres',
        },
      );
      const markers = restoreMarkerEvidence(
        postgresQueryJson(kubectl, 'ql3-dr', ready.value.primary, markerSql),
        expectAfter,
      );
      const databaseContract = postgresDatabaseContractEvidence(
        postgresQueryJson(
          kubectl,
          'ql3-dr',
          ready.value.primary,
          databaseContractSql,
        ),
      );
      const applicationProbe = postgresRestoreApplicationProbeResources({
        clusterName,
        controlImage: clusterControlImage.runtimeImage,
        apiCredentialPepper: crypto.randomBytes(32).toString('base64url'),
      });
      kubectl(['apply', '-f', '-'], {
        input: `${JSON.stringify(applicationProbe)}\n`,
      });
      const applicationName = `ql3-dr-application-${
        clusterName.endsWith('-latest') ? 'latest' : 'pitr'
      }`;
      const applicationReady = await waitFor(
        `${clusterName} production application readiness`,
        10 * 60_000,
        () =>
          postgresRestoreApplicationRuntimeEvidence(
            kubectlJson([
              '-n',
              'ql3-dr',
              'get',
              `deployment/${applicationName}`,
            ]),
            kubectlJson([
              '-n',
              'ql3-dr',
              'get',
              'pods',
              '-l',
              `app.kubernetes.io/name=${applicationName}`,
            ]).items,
            clusterName,
          ),
      );
      const applicationImage = runtimeImageEvidence(
        applicationReady.value.pod,
        'cluster-control',
        clusterControlImage.runtimeImage,
        clusterControlImage.platformDigest,
      );
      const applicationRtoMs = Date.now() - startedAt;
      const images = ready.value.pods.map((pod) =>
        runtimeImageEvidence(
          pod,
          'postgres',
          IMAGES.postgres,
          expected.postgres,
        ),
      );
      return Object.freeze({
        cluster: clusterName,
        sourceObjectStore: 'ql3-postgres-recovery-source',
        sourceServerName: 'ql3-postgres',
        targetWalArchiver: false,
        instances: 3,
        ready: true,
        primary: ready.value.primary,
        nodes: ready.value.nodes,
        synchronousCommit: 'remote_apply',
        synchronousStandbys: 1,
        migrationCount: databaseContract.migrationCount,
        controlCoreCapability: databaseContract.controlCoreCapability,
        databaseOwner: databaseContract.databaseOwner,
        roles: databaseContract.roles,
        beforeMarkerPresent: markers.beforeMarkerPresent,
        afterMarkerPresent: markers.afterMarkerPresent,
        databaseRtoMs,
        applicationRtoMs,
        applicationReady: true,
        applicationImage,
        images: Object.freeze(images),
      });
    };
    const latestRestore = await restoreCluster({
      clusterName: 'ql3-postgres-restore-latest',
      expectAfter: true,
    });
    kubectl([
      '-n',
      'ql3-dr',
      'delete',
      'deployment/ql3-dr-application-latest',
      'secret/ql3-dr-application-latest-security',
      '--wait=true',
      '--timeout=5m',
    ]);
    kubectl([
      '-n',
      'ql3-dr',
      'delete',
      'cluster/ql3-postgres-restore-latest',
      '--wait=true',
      '--timeout=10m',
    ]);
    kubectl([
      '-n',
      'ql3-dr',
      'delete',
      'pvc',
      '-l',
      'cnpg.io/cluster=ql3-postgres-restore-latest',
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=10m',
    ]);
    const pitrRestore = await restoreCluster({
      clusterName: 'ql3-postgres-restore-pitr',
      targetTime: pitrTarget,
      expectAfter: false,
    });
    const sourceClusterAfterRestores = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'cluster/ql3-postgres',
    ]);
    assert.equal(sourceClusterAfterRestores.metadata.uid, sourceUid);
    assert.deepEqual(
      sourceClusterAfterRestores.spec,
      sourceClusterBeforeRestores.spec,
    );
    const sourceAfterRestores = postgresClusterRuntimeEvidence(
      sourceClusterAfterRestores,
      kubectlJson([
        '-n',
        'ql3-dr',
        'get',
        'pods',
        '-l',
        'cnpg.io/cluster=ql3-postgres',
      ]).items,
    );
    assert.equal(sourceAfterRestores.ready, true);

    const minioPod = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'pods',
      '-l',
      'app=ql3-minio',
    ]).items[0];
    const minioImage = runtimeImageEvidence(
      minioPod,
      'minio',
      IMAGES.minio,
      expected.minio,
    );
    const minioClientPod = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'pods',
      '-l',
      'job-name=ql3-minio-bootstrap',
    ]).items[0];
    const minioClientImage = runtimeImageEvidence(
      minioClientPod,
      'mc',
      IMAGES.minioClient,
      expected.minioClient,
    );

    const certManagerPods = kubectlJson([
      '-n',
      'cert-manager',
      'get',
      'pods',
    ]).items;
    const certManagerImageKeys = Object.freeze({
      'cert-manager-controller': 'certManager',
      'cert-manager-cainjector': 'certManagerCainjector',
      'cert-manager-webhook': 'certManagerWebhook',
    });
    const certManagerByContainer = Object.fromEntries(
      certManagerPods.flatMap((pod) =>
        (pod.status.containerStatuses || [])
          .filter((status) => certManagerImageKeys[status.name])
          .map((status) => {
            const imageKey = certManagerImageKeys[status.name];
            return [
              status.name,
              runtimeImageEvidence(
                pod,
                status.name,
                IMAGES[imageKey],
                expected[imageKey],
              ),
            ];
          }),
      ),
    );
    assert.deepEqual(
      Object.keys(certManagerByContainer).sort(),
      Object.keys(certManagerImageKeys).sort(),
    );

    const cnpgPod = kubectlJson([
      '-n',
      'cnpg-system',
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/name=cloudnative-pg',
    ]).items[0];
    const cnpgImage = runtimeImageEvidence(
      cnpgPod,
      'manager',
      IMAGES.cnpg,
      expected.cnpg,
    );

    const barmanPod = kubectlJson([
      '-n',
      'cnpg-system',
      'get',
      'pods',
      '-l',
      'app=barman-cloud',
    ]).items[0];
    const barmanImage = runtimeImageEvidence(
      barmanPod,
      'barman-cloud',
      IMAGES.barman,
      expected.barman,
    );

    const minioCaSecret = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'secret/ql3-minio-ca',
    ]);
    const minioServerSecret = kubectlJson([
      '-n',
      'ql3-dr',
      'get',
      'secret/ql3-minio-tls',
    ]);
    assert.deepEqual(Object.keys(clientSecret.data).sort(), [
      'ca.crt',
      'tls.crt',
      'tls.key',
    ]);
    assert.deepEqual(Object.keys(serverSecret.data).sort(), [
      'ca.crt',
      'tls.crt',
      'tls.key',
    ]);

    assert.equal(migrationImage.imageId, clusterControlImage.platformDigest);
    assert.equal(
      latestRestore.applicationImage.imageId,
      clusterControlImage.platformDigest,
    );
    assert.equal(
      pitrRestore.applicationImage.imageId,
      clusterControlImage.platformDigest,
    );
    assert.equal(minioImage.imageId, expected.minio);
    assert.equal(minioClientImage.imageId, expected.minioClient);
    certificateEvidence(minioCaSecret);
    certificateEvidence(minioServerSecret);
    const restoreEvidence = (restore, targetTime) =>
      Object.freeze({
        cluster: restore.cluster,
        sourceObjectStore: restore.sourceObjectStore,
        sourceServerName: restore.sourceServerName,
        sourceClusterUnmodified: true,
        targetWalArchiver: false,
        instances: restore.instances,
        ready: restore.ready,
        migrationCount: restore.migrationCount,
        controlCoreCapability: restore.controlCoreCapability,
        databaseOwner: restore.databaseOwner,
        synchronousCommit: restore.synchronousCommit,
        synchronousStandbys: restore.synchronousStandbys,
        roles: restore.roles,
        beforeMarkerPresent: restore.beforeMarkerPresent,
        afterMarkerPresent: restore.afterMarkerPresent,
        ...(targetTime === undefined ? {} : { targetTime }),
      });
    const toSeconds = (milliseconds) =>
      Number((milliseconds / 1_000).toFixed(3));
    const report = auditedCloudNativePgDrEvidence({
      schemaVersion: 1,
      fixture: 'qinglong/cloudnativepg-disaster-recovery@v1',
      observedAt: new Date().toISOString(),
      sourceRevision,
      platform: Object.freeze({
        kubernetesVersion: K3S_VERSION,
        architecture,
        cloudNativePgVersion: CNPG_VERSION,
        cloudNativePgImageId: cnpgImage.imageId,
        postgresVersionNumber: sourceDatabaseContract.postgresVersionNumber,
        postgresImageId: sourcePostgresImages[0].imageId,
        barmanVersion: BARMAN_VERSION,
        barmanControllerImageId: barmanImage.imageId,
        barmanSidecarImageIds: Object.freeze(
          sourceBarmanSidecarImages.map(({ imageId }) => imageId),
        ),
        certManagerVersion: CERT_MANAGER_VERSION,
        certManagerImageIds: Object.freeze([
          certManagerByContainer['cert-manager-controller'].imageId,
          certManagerByContainer['cert-manager-cainjector'].imageId,
          certManagerByContainer['cert-manager-webhook'].imageId,
        ]),
      }),
      source: Object.freeze({
        cluster: 'ql3-postgres',
        backup: Object.freeze({
          name: 'ql3-postgres-base-backup',
          phase: baseBackup.value.phase,
          startedAt: baseBackup.value.startedAt,
          completedAt: baseBackup.value.stoppedAt,
          beginWal: baseBackup.value.beginWal,
          endWal: baseBackup.value.endWal,
        }),
        markers: Object.freeze({
          before: beforeMarker,
          after: afterMarker,
        }),
        wal: Object.freeze({
          archiveHealthy: true,
          continuous: true,
          noGaps: true,
          lastArchivedWal: walBeforeRestores.value.lastArchivedWal,
        }),
      }),
      latestRestore: restoreEvidence(latestRestore),
      pitrRestore: restoreEvidence(pitrRestore, pitrTarget),
      certificateRotation: Object.freeze({
        client: rotatedCertificates.value.clientRotation,
        server: rotatedCertificates.value.serverRotation,
        walArchivedDuringRotation: true,
        backupCompletedAfterRotation: true,
        latestRestoreCompletedAfterRotation: true,
        pitrCompletedAfterRotation: true,
        maxObservedInterruptionSeconds: toSeconds(
          rotatedCertificates.elapsedMs,
        ),
      }),
      objectStoreAuthority: Object.freeze({
        sourceObjectStore: 'ql3-postgres-backup',
        recoveryObjectStore: 'ql3-postgres-recovery-source',
        sourceWriterIdentitySha256: `sha256:${sha256(
          Buffer.from(minioCredentials.writer.accessKey, 'utf8'),
        )}`,
        recoveryReaderIdentitySha256: `sha256:${sha256(
          Buffer.from(minioCredentials.recovery.accessKey, 'utf8'),
        )}`,
        recoveryReadOnly: true,
        versioning: true,
        immutability: true,
        lifecycleDays: 45,
      }),
      serviceLevels: Object.freeze({
        targetMaxRpoSeconds: 60,
        observedRpoSeconds: Number(observedRpoSeconds.toFixed(3)),
        targetMaxDatabaseRtoSeconds: 1_200,
        latestDatabaseRtoSeconds: toSeconds(latestRestore.databaseRtoMs),
        pitrDatabaseRtoSeconds: toSeconds(pitrRestore.databaseRtoMs),
        targetMaxApplicationRtoSeconds: 1_800,
        latestApplicationRtoSeconds: toSeconds(latestRestore.applicationRtoMs),
        pitrApplicationRtoSeconds: toSeconds(pitrRestore.applicationRtoMs),
      }),
      gates: Object.freeze({
        latestRestore: true,
        pointInTimeRestore: true,
        schemaAndRoles: true,
        sourceIsolation: true,
        certificateRotation: true,
        serviceLevels: true,
        passed: true,
      }),
    });
    if (evidenceReportPath !== undefined) {
      writePrivateEvidenceReport(evidenceReportPath, report);
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    try {
      for (const container of nodes) {
        const stateResult = run(
          docker,
          ['inspect', '--format', '{{json .State}}', container],
          { capture: true, quiet: true, allowFailure: true },
        );
        if (stateResult.status !== 0) continue;
        const state = JSON.parse(stateResult.stdout);
        const logs = run(docker, ['logs', '--tail', '80', container], {
          capture: true,
          quiet: true,
          allowFailure: true,
        });
        const diagnostic = {
          container,
          state: {
            status: state.Status,
            running: state.Running,
            oomKilled: state.OOMKilled,
            exitCode: state.ExitCode,
            error: state.Error,
            finishedAt: state.FinishedAt,
          },
          logs: redactRuntimeText(
            [logs.stdout, logs.stderr].filter(Boolean).join('\n'),
            [clusterToken],
          ).slice(-16_384),
        };
        process.stderr.write(
          `container-diagnostic ${JSON.stringify(diagnostic)}\n`,
        );
      }
      if (fs.existsSync(kubeconfig)) {
        run(
          kubectlBinary,
          ['--kubeconfig', kubeconfig, 'get', 'pods', '-A', '-o', 'wide'],
          { quiet: true, allowFailure: true },
        );
      }
    } catch {
      // Diagnostics cannot replace the original failure.
    }
    throw error;
  } finally {
    if (keep) {
      process.stderr.write(
        `preserving ${prefix}; kubeconfig=${kubeconfig}; network=${network}\n`,
      );
    } else {
      for (const container of [...createdContainers].reverse()) {
        run(docker, ['rm', '-f', '-v', container], {
          capture: true,
          quiet: true,
          allowFailure: true,
        });
      }
      if (networkCreated) {
        run(docker, ['network', 'rm', network], {
          capture: true,
          quiet: true,
          allowFailure: true,
        });
      }
      for (const image of builtImages) {
        run(docker, ['image', 'rm', '-f', image], {
          capture: true,
          quiet: true,
          allowFailure: true,
        });
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  assertCloudNativePgDrRunnerCapacity,
  auditedCloudNativePgDrEvidence,
  backupRuntimeEvidence,
  buildClusterControlImage,
  certificateEvidence,
  certificateRotationEvidence,
  digestOnlyReference,
  imageIdDigest,
  kubernetesSecret,
  minioFixtureResources,
  mirrorPlatformImage,
  parseEvidenceReportPath,
  platformDigestFromImageIndex,
  podReady,
  preflightPrivateEvidenceReportPath,
  privateDockerDataBindArgs,
  postgresArchiverEvidence,
  postgresClusterRuntimeEvidence,
  postgresDatabaseContractEvidence,
  postgresMigrationJobResource,
  postgresMarkerEvidence,
  postgresRoleEvidence,
  postgresRoleSecretResources,
  postgresRestoreFixtureResources,
  postgresRestoreApplicationProbeResources,
  postgresRestoreApplicationRuntimeEvidence,
  postgresSourceFixtureResources,
  postgresQueryJson,
  postgresSql,
  redactRuntimeText,
  replaceExactlyOnce,
  restoreMarkerEvidence,
  reviewedManifest,
  runtimeImageEvidence,
  webhookConfigurationHasCaBundle,
  writePrivateEvidenceReport,
};
