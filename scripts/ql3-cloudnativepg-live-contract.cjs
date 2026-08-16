#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const ROOT = path.resolve(__dirname, '..');
const QL3_VERSION = readReleaseIdentity(ROOT).version;
const NAMESPACE = 'qinglong3-system';
const POSTGRES_CLUSTER = 'ql3-postgres';
const APP_IMAGE = `registry.example.com/qinglong/qinglong3-cluster-control:${QL3_VERSION}`;
const APP_IMAGE_PLACEHOLDER = `registry.example.com/qinglong/qinglong3-cluster-control@sha256:${'0'.repeat(
  64,
)}`;
const KIND_NODE_IMAGE =
  'kindest/node:v1.32.8@sha256:abd489f042d2b644e2d033f5c2d900bc707798d075e8186cb65e3f1367a9d5a1';
const OPERATOR_LOCK = Object.freeze(
  JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/operator-lock.json',
      ),
      'utf8',
    ),
  ),
);
const OPERATOR_IMAGE = OPERATOR_LOCK.operator.image;
const OPERATOR_MANIFEST = OPERATOR_LOCK.operator.releaseManifest;
const OPERATOR_MANIFEST_SHA256 = OPERATOR_LOCK.operator.releaseManifestSha256;
const POSTGRES_IMAGE = OPERATOR_LOCK.operand.image;
const OPERATOR_PLATFORM_DIGESTS = Object.freeze({
  amd64: OPERATOR_LOCK.operator.platforms['linux/amd64'],
  arm64: OPERATOR_LOCK.operator.platforms['linux/arm64'],
});
const POSTGRES_PLATFORM_DIGESTS = Object.freeze({
  amd64: OPERATOR_LOCK.operand.platforms['linux/amd64'],
  arm64: OPERATOR_LOCK.operand.platforms['linux/arm64'],
});
const ROLE_NAMES = Object.freeze([
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

function fail(message) {
  throw new Error(message);
}

function executable(name, fallback = name) {
  return process.env[name] || fallback;
}

const KIND = executable('QL3_KIND_BIN', 'kind');
const KUBECTL = executable('QL3_KUBECTL_BIN', 'kubectl');
const DOCKER = executable('QL3_DOCKER_BIN', 'docker');
const CURL = executable('QL3_CURL_BIN', 'curl');
const OPENSSL = executable('QL3_OPENSSL_BIN', 'openssl');

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
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    fail(
      `${path.basename(binary)} exited with status ${String(
        result.status,
      )}${detail}`,
    );
  }
  return capture ? result.stdout.trim() : '';
}

function docker(args, options) {
  return run(DOCKER, args, options);
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
  });
  return JSON.parse(output);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, inspect) {
  const startedAt = Date.now();
  let lastFact = 'not observed';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = inspect();
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
    await sleep(5_000);
  }
  fail(`${description} timed out after ${timeoutMs}ms: ${lastFact}`);
}

function normalizeArchitecture(value) {
  if (value === 'x86_64' || value === 'x64') return 'amd64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function applySecret(name, type, stringData) {
  const body = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: name.startsWith('ql3-postgres-')
        ? { 'cnpg.io/reload': 'true' }
        : undefined,
    },
    type,
    stringData,
  });
  kubectl(['apply', '-f', '-'], {
    input: body,
    label: `kubectl apply Secret/${name} (values redacted)`,
  });
}

function createWorkerIngressTls(directory) {
  const tlsDirectory = path.join(directory, 'worker-ingress-tls');
  fs.mkdirSync(tlsDirectory, { mode: 0o700 });
  const caKey = path.join(tlsDirectory, 'ca.key');
  const caCertificate = path.join(tlsDirectory, 'ca.crt');
  const serverKey = path.join(tlsDirectory, 'tls.key');
  const serverRequest = path.join(tlsDirectory, 'tls.csr');
  const serverCertificate = path.join(tlsDirectory, 'tls.crt');
  const serverExtensions = path.join(tlsDirectory, 'server.ext');
  fs.writeFileSync(
    serverExtensions,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:ql3-cluster-control,DNS:ql3-cluster-control.qinglong3-system.svc,DNS:ql3-cluster-control.qinglong3-system.svc.cluster.local',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  run(
    OPENSSL,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-sha256',
      '-subj',
      '/CN=QL3 CloudNativePG Live Worker CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',
      caKey,
      '-out',
      caCertificate,
    ],
    { capture: true, quiet: true },
  );
  run(
    OPENSSL,
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=ql3-cluster-control.qinglong3-system.svc',
      '-keyout',
      serverKey,
      '-out',
      serverRequest,
    ],
    { capture: true, quiet: true },
  );
  run(
    OPENSSL,
    [
      'x509',
      '-req',
      '-days',
      '1',
      '-sha256',
      '-in',
      serverRequest,
      '-CA',
      caCertificate,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-extfile',
      serverExtensions,
      '-out',
      serverCertificate,
    ],
    { capture: true, quiet: true },
  );
  return Object.freeze({
    privateKey: fs.readFileSync(serverKey, 'utf8'),
    certificate: fs.readFileSync(serverCertificate, 'utf8'),
    clientCa: fs.readFileSync(caCertificate, 'utf8'),
  });
}

function clusterStatus() {
  return kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'cluster.postgresql.cnpg.io',
    POSTGRES_CLUSTER,
  ]).status;
}

function postgresPods() {
  return kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    `cnpg.io/cluster=${POSTGRES_CLUSTER}`,
  ]).items;
}

function podReady(pod) {
  return pod.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
}

function currentPrimary() {
  const primary = clusterStatus()?.currentPrimary;
  assert.match(primary || '', /^ql3-postgres-[1-9][0-9]*$/);
  return primary;
}

function currentPrimaryPod() {
  const primary = currentPrimary();
  const pod = postgresPods().find(
    (candidate) => candidate.metadata.name === primary,
  );
  assert.ok(pod, `primary Pod ${primary} is missing`);
  return pod;
}

function psql(podName, sql) {
  return kubectl(
    [
      '-n',
      NAMESPACE,
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
      '--field-separator',
      '\t',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { capture: true, quiet: true },
  );
}

function timeline(podName) {
  const value = Number.parseInt(
    psql(podName, 'SELECT timeline_id FROM pg_control_checkpoint()'),
    10,
  );
  assert.ok(Number.isSafeInteger(value) && value > 0, 'invalid timeline');
  return value;
}

function roleEvidence(podName) {
  const roleList = ROLE_NAMES.map((role) => `'${role}'`).join(', ');
  const output = psql(
    podName,
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
            rolreplication, rolbypassrls
       FROM pg_roles
      WHERE rolname IN (${roleList})
      ORDER BY rolname`,
  );
  const rows = output
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('\t'));
  assert.deepEqual(
    rows.map((row) => row[0]),
    ROLE_NAMES,
  );
  for (const row of rows) {
    assert.deepEqual(row.slice(1), ['t', 'f', 'f', 'f', 'f', 'f']);
  }
  const schema = psql(
    podName,
    `SELECT
       (SELECT count(*) FROM ql3.schema_migrations),
       (SELECT contract_version
          FROM ql3.schema_capabilities
         WHERE contract_name = 'control-core')`,
  ).split('\t');
  assert.deepEqual(schema, ['53', '52']);
  return {
    roles: rows.map((row) => row[0]),
    login: true,
    elevatedAttributes: false,
    migrationCount: 54,
    contractVersion: 53,
  };
}

function leaseEvidence() {
  const leases = kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'leases.coordination.k8s.io',
  ])
    .items.filter(
      (lease) =>
        lease.metadata.name.includes(POSTGRES_CLUSTER) ||
        lease.metadata.labels?.['cnpg.io/cluster'] === POSTGRES_CLUSTER,
    )
    .map((lease) => ({
      name: lease.metadata.name,
      holderIdentity: lease.spec?.holderIdentity || null,
      leaseTransitions: lease.spec?.leaseTransitions ?? null,
      renewTime: lease.spec?.renewTime || null,
    }));
  assert.ok(leases.length > 0, 'CloudNativePG Lease was not observed');
  return leases;
}

function imageDigest(reference) {
  const match =
    typeof reference === 'string'
      ? /@((?:sha256:)[a-f0-9]{64})$/.exec(reference)
      : null;
  assert.ok(match, 'reviewed image reference must end in one sha256 digest');
  return match[1];
}

function imageTag(reference) {
  const digest = imageDigest(reference);
  const tag = reference.slice(0, -`@${digest}`.length);
  assert.ok(
    tag.lastIndexOf(':') > tag.lastIndexOf('/'),
    'reviewed image reference must retain an explicit tag before its digest',
  );
  return tag;
}

function localApplicationManifest(rendered) {
  assert.equal(
    rendered.split(APP_IMAGE_PLACEHOLDER).length - 1,
    1,
    'rendered application manifest must contain exactly one fail-closed image placeholder',
  );
  const local = rendered.replace(APP_IMAGE_PLACEHOLDER, APP_IMAGE);
  assert.ok(
    !local.includes(`@sha256:${'0'.repeat(64)}`),
    'rendered application manifest retained a fail-closed image placeholder',
  );
  return local;
}

function verifyImageIds(pods, expectedDigests, description) {
  assert.ok(
    Array.isArray(expectedDigests) &&
      expectedDigests.length >= 1 &&
      expectedDigests.every(
        (digest) =>
          typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest),
      ),
    `${description} reviewed digest set is invalid`,
  );
  const imageIds = pods.flatMap((pod) =>
    (pod.status?.containerStatuses || []).map((status) => status.imageID),
  );
  assert.ok(imageIds.length > 0, `${description} imageID is missing`);
  for (const imageId of imageIds) {
    assert.ok(
      expectedDigests.some((digest) => imageId.includes(digest)),
      `${description} is not running a reviewed index/platform digest: ${imageId}`,
    );
  }
  return [...new Set(imageIds)];
}

function operatorPods() {
  return kubectlJson(['-n', 'cnpg-system', 'get', 'pods']).items.filter((pod) =>
    (pod.spec?.containers || []).some((container) =>
      container.image.includes('cloudnative-pg'),
    ),
  );
}

function nodeReady(name) {
  const node = kubectlJson(['get', 'node', name]);
  return node.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
}

function createKindConfig(target) {
  fs.writeFileSync(
    target,
    `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
  - role: worker
networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/16
`,
    { mode: 0o600 },
  );
}

function proxySafeEnvironment() {
  const local = [
    '127.0.0.1',
    'localhost',
    '::1',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '.svc',
    '.cluster.local',
  ];
  const inherited = process.env.NO_PROXY || process.env.no_proxy || '';
  const noProxy = [
    ...new Set([...inherited.split(',').filter(Boolean), ...local]),
  ].join(',');
  return { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy };
}

function manifestSha256(filePath) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function reviewedOperatorManifest(filePath) {
  assert.ok(
    path.isAbsolute(filePath),
    'operator manifest path must be absolute',
  );
  const stat = fs.lstatSync(filePath);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size >= 1024 &&
      stat.size <= 5 * 1024 * 1024 &&
      (stat.mode & 0o022) === 0 &&
      fs.realpathSync(filePath) === filePath,
    'operator manifest must be one canonical non-writable regular file between 1 KiB and 5 MiB',
  );
  assert.equal(
    manifestSha256(filePath),
    OPERATOR_MANIFEST_SHA256,
    'operator manifest does not match the reviewed lock digest',
  );
  return filePath;
}

async function main() {
  if (process.env.QL3_CLOUDNATIVEPG_LIVE !== '1') {
    fail(
      'Refusing to mutate Docker/Kubernetes without QL3_CLOUDNATIVEPG_LIVE=1',
    );
  }

  const clusterName =
    process.env.QL3_KIND_CLUSTER ||
    `ql3-cnpg-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  assert.match(clusterName, /^ql3-cnpg-[a-z0-9-]{1,48}$/);
  const keepCluster = process.env.QL3_KEEP_KIND_CLUSTER === '1';
  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-cnpg-live-'),
  );
  kubeconfig = path.join(tempDirectory, 'kubeconfig');
  const kindConfig = path.join(tempDirectory, 'kind.yaml');
  const downloadedOperatorManifest = path.join(
    tempDirectory,
    'cnpg-1.30.0.yaml',
  );
  createKindConfig(kindConfig);

  let clusterCreated = false;
  let stoppedNode = '';
  const evidence = {
    fixture: 'qinglong/cloudnativepg-live-contract@v1',
    clusterName,
    kubernetes: { nodeImage: KIND_NODE_IMAGE, nodeCount: 4 },
    operator: { image: OPERATOR_IMAGE },
    postgres: {},
    application: { image: APP_IMAGE },
    failover: {},
  };

  try {
    const architecture = normalizeArchitecture(
      docker(['info', '--format', '{{.Architecture}}'], {
        capture: true,
        quiet: true,
      }),
    );
    assert.ok(
      OPERATOR_PLATFORM_DIGESTS[architecture],
      `unsupported Docker architecture ${architecture}`,
    );
    evidence.architecture = architecture;

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
      { env: proxySafeEnvironment() },
    );
    clusterCreated = true;

    kubectl([
      'wait',
      '--for=condition=Ready',
      'nodes',
      '--all',
      '--timeout=5m',
    ]);
    const nodes = kubectlJson(['get', 'nodes']).items;
    assert.equal(nodes.length, 4);
    evidence.kubernetes.nodes = nodes.map((node) => node.metadata.name).sort();

    for (const reviewedImage of [OPERATOR_IMAGE, POSTGRES_IMAGE]) {
      docker(['pull', reviewedImage]);
      const inspected = JSON.parse(
        docker(['image', 'inspect', reviewedImage], {
          capture: true,
          quiet: true,
        }),
      );
      assert.equal(inspected.length, 1);
      assert.ok(
        inspected[0].RepoDigests?.some((value) =>
          value.endsWith(`@${imageDigest(reviewedImage)}`),
        ),
        `Docker did not retain the reviewed digest for ${reviewedImage}`,
      );
      const preloadTag = imageTag(reviewedImage);
      docker(['tag', reviewedImage, preloadTag]);
      kind(['load', 'docker-image', preloadTag, '--name', clusterName]);
    }

    let operatorManifest;
    if (process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE) {
      operatorManifest = reviewedOperatorManifest(
        process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE,
      );
    } else {
      run(
        CURL,
        [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--http1.1',
          '--connect-timeout',
          '15',
          '--max-time',
          '300',
          '--retry',
          '4',
          '--retry-all-errors',
          '--retry-max-time',
          '300',
          '--output',
          downloadedOperatorManifest,
          OPERATOR_MANIFEST,
        ],
        { label: 'download official CloudNativePG 1.30.0 release manifest' },
      );
      fs.chmodSync(downloadedOperatorManifest, 0o600);
      operatorManifest = reviewedOperatorManifest(downloadedOperatorManifest);
    }
    evidence.operator.manifestSha256 = manifestSha256(operatorManifest);
    const manifestText = fs.readFileSync(operatorManifest, 'utf8');
    assert.match(manifestText, /cloudnative-pg/);
    assert.match(manifestText, /cnpg-controller-manager/);
    kubectl(['apply', '--server-side', '-f', operatorManifest]);
    kubectl([
      '-n',
      'cnpg-system',
      'set',
      'image',
      'deployment/cnpg-controller-manager',
      `manager=${OPERATOR_IMAGE}`,
    ]);
    kubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusters.postgresql.cnpg.io',
      'crd/databaseroles.postgresql.cnpg.io',
      'crd/databases.postgresql.cnpg.io',
      '--timeout=5m',
    ]);
    kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '--timeout=5m',
    ]);
    evidence.operator.imageIds = verifyImageIds(
      operatorPods(),
      [imageDigest(OPERATOR_IMAGE), OPERATOR_PLATFORM_DIGESTS[architecture]],
      'CloudNativePG operator',
    );

    kubectl([
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/namespace.yaml',
    ]);
    kubectl([
      '-n',
      NAMESPACE,
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/service-account.yaml',
    ]);
    const passwords = Object.freeze({
      ql3_migration: randomSecret(),
      ql3_runtime: randomSecret(),
      ql3_admin: randomSecret(),
      ql3_automation_manager: randomSecret(),
      ql3_approval_manager: randomSecret(),
      ql3_package_manager: randomSecret(),
      ql3_package_executor: randomSecret(),
      ql3_worker_credential_manager: randomSecret(),
      ql3_worker_credential_executor: randomSecret(),
      ql3_worker_ingress: randomSecret(),
    });
    for (const [role, password] of Object.entries(passwords)) {
      applySecret(
        `ql3-postgres-${role.replace(/^ql3_/, '').replaceAll('_', '-')}-auth`,
        'kubernetes.io/basic-auth',
        { username: role, password },
      );
    }
    applySecret('ql3-cluster-control-runtime', 'Opaque', {
      'api-credential-pepper': randomSecret(),
    });
    const workerIngressTls = createWorkerIngressTls(tempDirectory);
    applySecret('ql3-cluster-worker-ingress', 'Opaque', {
      'worker-credential-pepper': randomSecret(),
      'artifact-s3-bucket': 'ql3-live-private-artifacts',
      'artifact-s3-region': 'us-east-1',
      'artifact-s3-encryption': 's3',
      'tls.key': workerIngressTls.privateKey,
      'tls.crt': workerIngressTls.certificate,
      'client-ca.crt': workerIngressTls.clientCa,
    });

    kubectl([
      'apply',
      '-k',
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg',
    ]);
    kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Ready',
      `cluster/${POSTGRES_CLUSTER}`,
      '--timeout=20m',
    ]);
    const readyDatabase = await waitFor(
      'three CloudNativePG instances on distinct nodes',
      10 * 60_000,
      () => {
        const pods = postgresPods();
        const ready = pods.filter(podReady);
        const nodes = new Set(ready.map((pod) => pod.spec.nodeName));
        return {
          ready: ready.length === 3 && nodes.size === 3,
          value: ready,
          fact: `${ready.length} ready Pods across ${nodes.size} nodes`,
        };
      },
    );
    const databasePods = readyDatabase.value;
    evidence.postgres.initialReadyMs = readyDatabase.elapsedMs;
    evidence.postgres.nodes = databasePods
      .map((pod) => pod.spec.nodeName)
      .sort();
    evidence.postgres.imageIds = verifyImageIds(
      databasePods,
      [imageDigest(POSTGRES_IMAGE), POSTGRES_PLATFORM_DIGESTS[architecture]],
      'CloudNativePG PostgreSQL operand',
    );
    kubectl(['-n', NAMESPACE, 'get', 'secret', 'ql3-postgres-ca']);
    evidence.postgres.caSecret = 'ql3-postgres-ca/ca.crt';

    docker([
      'build',
      '--file',
      'deploy/containers/ql3-cluster-control/Dockerfile',
      '--tag',
      APP_IMAGE,
      '--build-arg',
      `SOURCE_REVISION=${process.env.GITHUB_SHA || 'live-contract'}`,
      '.',
    ]);
    kind(['load', 'docker-image', APP_IMAGE, '--name', clusterName]);

    const migrationManifest = localApplicationManifest(
      kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ),
    );
    kubectl(['create', '-f', '-'], { input: migrationManifest });
    kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Complete',
      'job/ql3-cluster-migration',
      '--timeout=10m',
    ]);
    const migrationLog = kubectl(
      ['-n', NAMESPACE, 'logs', 'job/ql3-cluster-migration'],
      { capture: true, quiet: true },
    );
    assert.match(migrationLog, /"event":"migration_completed"/);
    evidence.application.migrationCompleted = true;

    const runtimeManifest = localApplicationManifest(
      kubectl(
        ['kustomize', 'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg'],
        { capture: true, quiet: true },
      ),
    );
    kubectl(['apply', '-f', '-'], { input: runtimeManifest });
    kubectl([
      '-n',
      NAMESPACE,
      'rollout',
      'status',
      'deployment/ql3-cluster-control',
      '--timeout=10m',
    ]);
    const runtimePods = kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/name=ql3-cluster-control',
    ]).items.filter(podReady);
    assert.equal(runtimePods.length, 2);
    assert.equal(new Set(runtimePods.map((pod) => pod.spec.nodeName)).size, 2);
    evidence.application.readyReplicas = 2;
    evidence.application.nodes = runtimePods
      .map((pod) => pod.spec.nodeName)
      .sort();

    const oldPrimaryPod = currentPrimaryPod();
    const oldPrimary = oldPrimaryPod.metadata.name;
    const oldPrimaryNode = oldPrimaryPod.spec.nodeName;
    assert.match(oldPrimaryNode, new RegExp(`^${clusterName}-worker[0-9]*$`));
    const oldTimeline = timeline(oldPrimary);
    const leasesBefore = leaseEvidence();
    const failoverStartedAt = Date.now();

    stoppedNode = oldPrimaryNode;
    docker(['stop', '--time', '1', stoppedNode]);
    const promoted = await waitFor(
      'CloudNativePG promotion after primary node loss',
      10 * 60_000,
      () => {
        const status = clusterStatus();
        return {
          ready:
            status?.currentPrimary &&
            status.currentPrimary !== oldPrimary &&
            Number(status.readyInstances) >= 2,
          value: status.currentPrimary,
          fact: `primary=${status?.currentPrimary || 'none'}, ready=${String(
            status?.readyInstances,
          )}`,
        };
      },
    );
    const newPrimary = promoted.value;
    const newTimeline = timeline(newPrimary);
    assert.ok(newTimeline > oldTimeline, 'promotion did not advance timeline');
    const leasesAfterPromotion = leaseEvidence();

    docker(['start', stoppedNode]);
    await waitFor('restarted Kind node readiness', 5 * 60_000, () => ({
      ready: nodeReady(stoppedNode),
      fact: `${stoppedNode} is not Ready`,
    }));
    stoppedNode = '';
    const recovered = await waitFor(
      'old primary fenced recovery',
      15 * 60_000,
      () => {
        const pods = postgresPods();
        const ready = pods.filter(podReady);
        const status = clusterStatus();
        return {
          ready:
            ready.length === 3 &&
            status?.currentPrimary === newPrimary &&
            Number(status?.readyInstances) === 3,
          fact: `${ready.length} ready Pods; primary=${status?.currentPrimary}`,
        };
      },
    );
    kubectl([
      '-n',
      NAMESPACE,
      'rollout',
      'status',
      'deployment/ql3-cluster-control',
      '--timeout=10m',
    ]);

    const finalPrimary = currentPrimary();
    const roles = roleEvidence(finalPrimary);
    evidence.postgres.roles = roles;
    evidence.failover = {
      oldPrimary,
      oldPrimaryNode,
      oldTimeline,
      newPrimary,
      newTimeline,
      promotionMs: promoted.elapsedMs,
      recoveryMs: recovered.elapsedMs,
      totalMs: Date.now() - failoverStartedAt,
      leasesBefore,
      leasesAfterPromotion,
      finalReadyInstances: clusterStatus().readyInstances,
      oldPrimaryRecovered: true,
      runtimeReadyAfterFailover: true,
      caSecretPreserved: true,
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    if (clusterCreated) {
      try {
        kubectl(['get', 'nodes', '-o', 'wide'], { quiet: true });
        kubectl(['get', 'pods', '-A', '-o', 'wide'], { quiet: true });
        kubectl(
          [
            '-n',
            'cnpg-system',
            'logs',
            'deployment/cnpg-controller-manager',
            '--tail=300',
          ],
          { quiet: true },
        );
      } catch {
        // Best-effort diagnostics must not hide the original contract failure.
      }
    }
    throw error;
  } finally {
    if (stoppedNode) {
      try {
        docker(['start', stoppedNode], { quiet: true });
      } catch {
        // kind delete remains the bounded cleanup authority below.
      }
    }
    if (clusterCreated && !keepCluster) {
      kind([
        'delete',
        'cluster',
        '--name',
        clusterName,
        '--kubeconfig',
        kubeconfig,
      ]);
    } else if (clusterCreated) {
      process.stderr.write(
        `preserving ${clusterName}; kubeconfig=${kubeconfig}\n`,
      );
    }
    if (!keepCluster) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
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
  imageDigest,
  imageTag,
  localApplicationManifest,
  manifestSha256,
  reviewedOperatorManifest,
  verifyImageIds,
};
