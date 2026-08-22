const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  assertCloudNativePgDrRunnerCapacity,
  auditedCloudNativePgDrEvidence,
  backupRuntimeEvidence,
  certificateRotationEvidence,
  digestOnlyReference,
  imageIdDigest,
  minioFixtureResources,
  parseEvidenceReportPath,
  platformDigestFromImageIndex,
  preflightPrivateEvidenceReportPath,
  privateDockerDataBindArgs,
  postgresArchiverEvidence,
  postgresClusterRuntimeEvidence,
  postgresDatabaseContractEvidence,
  postgresMigrationJobResource,
  postgresMarkerEvidence,
  postgresRestoreFixtureResources,
  postgresRestoreApplicationProbeResources,
  postgresRestoreApplicationRuntimeEvidence,
  postgresRoleSecretResources,
  postgresSourceFixtureResources,
  postgresQueryJson,
  postgresSql,
  redactRuntimeText,
  replaceExactlyOnce,
  restoreMarkerEvidence,
  reviewedManifest,
  webhookConfigurationHasCaBundle,
  writePrivateEvidenceReport,
} = require('../../scripts/ql3-cloudnativepg-barman-live-contract.cjs');

const ROOT = path.resolve(__dirname, '../..');
const POSTGRES_ROLES = [
  'ql3_admin',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
  'ql3_ai_maintenance',
  'ql3_approval_manager',
  'ql3_automation_manager',
  'ql3_migration',
  'ql3_package_executor',
  'ql3_package_manager',
  'ql3_run_manager',
  'ql3_runtime',
  'ql3_worker_credential_executor',
  'ql3_worker_credential_manager',
  'ql3_worker_ingress',
];

test('rejects an undersized DR runner before creating temporary cluster state', () => {
  const gibibyte = 1024n * 1024n * 1024n;
  assert.deepEqual(
    assertCloudNativePgDrRunnerCapacity(() => ({
      bavail: 35n,
      bsize: gibibyte,
    })),
    {
      minimumBytes: 35n * gibibyte,
      availableBytes: 35n * gibibyte,
    },
  );
  assert.throws(
    () =>
      assertCloudNativePgDrRunnerCapacity(() => ({
        bavail: 34n,
        bsize: gibibyte,
      })),
    /requires at least 35 GiB free; found 36507222016 bytes/,
  );
});

test('extracts only an exact terminal Kubernetes platform image digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(imageIdDigest(`registry.example/image@${digest}`), digest);
  assert.throws(() => imageIdDigest('registry.example/image:latest'));
  assert.throws(() => imageIdDigest(`${digest}-suffix`));
});

test('removes a tag without confusing a registry port before Skopeo copy', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  assert.equal(
    digestOnlyReference(`registry.example:5443/team/image:v1@${digest}`),
    `registry.example:5443/team/image@${digest}`,
  );
  assert.equal(
    digestOnlyReference(`registry.example:5443/team/image@${digest}`),
    `registry.example:5443/team/image@${digest}`,
  );
  assert.throws(() => digestOnlyReference('registry.example/team/image:v1'));
});

test('redacts every runtime secret occurrence from failure diagnostics', () => {
  assert.equal(
    redactRuntimeText('token=secret; repeated=secret', ['secret']),
    'token=[REDACTED]; repeated=[REDACTED]',
  );
  assert.equal(redactRuntimeText('safe', ['', undefined]), 'safe');
});

test('resolves exactly one reviewed platform child from an OCI image index', () => {
  const amd64 = `sha256:${'a'.repeat(64)}`;
  const arm64 = `sha256:${'b'.repeat(64)}`;
  const index = {
    manifests: [
      { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: arm64, platform: { os: 'linux', architecture: 'arm64' } },
      {
        digest: `sha256:${'c'.repeat(64)}`,
        platform: { os: 'unknown', architecture: 'unknown' },
      },
    ],
  };
  assert.equal(platformDigestFromImageIndex(index, 'arm64'), arm64);
  assert.throws(() => platformDigestFromImageIndex(index, 's390x'));
  assert.throws(() =>
    platformDigestFromImageIndex(
      { manifests: [...index.manifests, index.manifests[1]] },
      'arm64',
    ),
  );
});

test('rewrites one reviewed release reference and rejects ambiguity', () => {
  assert.equal(
    replaceExactlyOnce(
      'image: product:v1',
      'product:v1',
      'product@sha256:locked',
    ),
    'image: product@sha256:locked',
  );
  assert.throws(() =>
    replaceExactlyOnce(
      'product:v1 product:v1',
      'product:v1',
      'product@sha256:locked',
    ),
  );
  assert.throws(() =>
    replaceExactlyOnce(
      'image: product:v2',
      'product:v1',
      'product@sha256:locked',
    ),
  );
});

test('accepts only a checksum-bound regular manifest before pinning images', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-barman-unit-'));
  const source = path.join(directory, 'source.yaml');
  const target = path.join(directory, 'pinned.yaml');
  try {
    const manifest = `${'x'.repeat(1024)}\nimage: product:v1\n`;
    fs.writeFileSync(source, manifest, { mode: 0o600, flag: 'wx' });
    const digest = crypto.createHash('sha256').update(manifest).digest('hex');
    const result = reviewedManifest(source, target, digest, [
      ['product:v1', `product:v1@sha256:${'b'.repeat(64)}`],
    ]);
    assert.equal(result.sourceSha256, digest);
    assert.match(fs.readFileSync(target, 'utf8'), /product:v1@sha256:b{64}/);

    assert.throws(() =>
      reviewedManifest(
        source,
        path.join(directory, 'rejected.yaml'),
        '0'.repeat(64),
        [],
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publishes a private evidence report atomically without overwriting history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-dr-report-'));
  const target = path.join(directory, 'report.json');
  const report = { schemaVersion: 1, fixture: 'test/evidence@v1' };
  try {
    assert.equal(
      parseEvidenceReportPath([`--report=${target}`]),
      path.normalize(target),
    );
    assert.equal(parseEvidenceReportPath([]), undefined);
    assert.throws(() => parseEvidenceReportPath(['--report=relative.json']));
    assert.throws(() =>
      parseEvidenceReportPath([`--report=${target}`, '--unexpected']),
    );
    assert.equal(
      preflightPrivateEvidenceReportPath(target),
      path.join(fs.realpathSync(directory), 'report.json'),
    );
    const published = writePrivateEvidenceReport(target, report);
    assert.equal(published.path, fs.realpathSync(target));
    assert.match(published.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), report);
    assert.throws(
      () => preflightPrivateEvidenceReportPath(target),
      /refusing to overwrite/,
    );
    assert.equal(fs.statSync(target).mode & 0o077, 0);
    assert.equal(
      fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')).length,
      0,
    );
    assert.throws(
      () => writePrivateEvidenceReport(target, { replaced: true }),
      {
        code: 'EEXIST',
      },
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('binds every image-declared data directory to private ephemeral storage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-dr-data-'));
  try {
    const targets = [
      '/var/lib/cni',
      '/var/lib/kubelet',
      '/var/lib/rancher/k3s',
      '/var/log',
    ];
    const args = privateDockerDataBindArgs(directory, 'ql3-test-node', targets);
    assert.equal(args.length, targets.length * 2);
    for (let index = 0; index < targets.length; index += 1) {
      assert.equal(args[index * 2], '--mount');
      const expectedDirectory = path.join(
        directory,
        'ql3-test-node',
        `${String(index).padStart(2, '0')}-${path.basename(targets[index])}`,
      );
      assert.equal(
        args[index * 2 + 1],
        `type=bind,src=${expectedDirectory},dst=${targets[index]}`,
      );
      assert.equal(fs.statSync(expectedDirectory).mode & 0o777, 0o700);
    }
    const registryArgs = privateDockerDataBindArgs(
      directory,
      'ql3-test-registry',
      ['/var/lib/registry'],
    );
    assert.match(
      registryArgs[1],
      /type=bind,src=.*\/ql3-test-registry\/00-registry,dst=\/var\/lib\/registry$/,
    );
    assert.throws(() =>
      privateDockerDataBindArgs('relative', 'ql3-test-node', targets),
    );
    assert.throws(() =>
      privateDockerDataBindArgs(directory, '../escape', targets),
    );
    assert.throws(() =>
      privateDockerDataBindArgs(directory, 'ql3-test-node', [
        '/var/lib/unreviewed',
      ]),
    );
    assert.throws(() =>
      privateDockerDataBindArgs(directory, 'ql3-test-node', [
        '/var/log',
        '/var/log',
      ]),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pins an explicitly reviewed repeated manifest reference count', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-barman-count-'));
  const source = path.join(directory, 'source.yaml');
  const target = path.join(directory, 'pinned.yaml');
  try {
    const manifest = `${'x'.repeat(
      1024,
    )}\nimage: product:v1\nenv: product:v1\n`;
    fs.writeFileSync(source, manifest, { mode: 0o600, flag: 'wx' });
    const digest = crypto.createHash('sha256').update(manifest).digest('hex');
    reviewedManifest(source, target, digest, [
      ['product:v1', `product:v1@sha256:${'c'.repeat(64)}`, 2],
    ]);
    assert.equal(
      fs.readFileSync(target, 'utf8').match(/product:v1@sha256:c{64}/g)?.length,
      2,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts cert-manager webhook readiness only after every CA bundle exists', () => {
  const ready = {
    webhooks: [
      { clientConfig: { caBundle: Buffer.from('ca-one').toString('base64') } },
      { clientConfig: { caBundle: Buffer.from('ca-two').toString('base64') } },
    ],
  };
  assert.equal(webhookConfigurationHasCaBundle(ready), true);
  assert.equal(
    webhookConfigurationHasCaBundle({
      webhooks: [ready.webhooks[0], { clientConfig: {} }],
    }),
    false,
  );
  assert.equal(webhookConfigurationHasCaBundle({ webhooks: [] }), false);
});

test('builds a TLS object store fixture with separate writer and read-only recovery authority', () => {
  const digest = `sha256:${'e'.repeat(64)}`;
  const credentials = {
    root: { accessKey: 'QL3ROOTTEST', secretKey: 'root-secret-value' },
    writer: { accessKey: 'QL3WRITERTEST', secretKey: 'writer-secret-value' },
    recovery: {
      accessKey: 'QL3RECOVERYTEST',
      secretKey: 'recovery-secret-value',
    },
  };
  const fixture = minioFixtureResources({
    minioImage: `registry:5000/ql3/minio@${digest}`,
    clientImage: `registry:5000/ql3/minio-client@${digest}`,
    credentials,
  });
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /root-secret-value|writer-secret-value/);
  assert.doesNotMatch(serialized, /recovery-secret-value/);

  const byKindAndName = (kind, name) =>
    fixture.core.items.find(
      (item) => item.kind === kind && item.metadata?.name === name,
    );
  const writerSecret = byKindAndName('Secret', 'ql3-object-store-writer');
  const recoverySecret = byKindAndName('Secret', 'ql3-object-store-recovery');
  assert.notDeepEqual(writerSecret.data, recoverySecret.data);

  const writerStore = byKindAndName('ObjectStore', 'ql3-postgres-backup');
  const recoveryStore = byKindAndName(
    'ObjectStore',
    'ql3-postgres-recovery-source',
  );
  assert.equal(writerStore.spec.retentionPolicy, '30d');
  assert.match(writerStore.spec.configuration.endpointURL, /^https:\/\//);
  assert.equal(writerStore.spec.configuration.endpointCA.name, 'ql3-minio-ca');
  assert.equal(
    writerStore.spec.configuration.s3Credentials.accessKeyId.name,
    'ql3-object-store-writer',
  );
  assert.equal(
    recoveryStore.spec.configuration.s3Credentials.accessKeyId.name,
    'ql3-object-store-recovery',
  );
  assert.equal(recoveryStore.spec.configuration.serverName, undefined);

  const deployment = byKindAndName('Deployment', 'ql3-minio');
  assert.deepEqual(
    deployment.spec.template.spec.containers[0].resources.limits,
    { cpu: '500m', memory: '512Mi' },
  );
  assert.equal(
    byKindAndName('Certificate', 'ql3-minio-server').spec.renewBefore,
    '1h',
  );
  assert.doesNotMatch(serialized, /renewalBefore/);
  const bootstrap = byKindAndName('Job', 'ql3-minio-bootstrap');
  const bootstrapScript = bootstrap.spec.template.spec.containers[0].command[2];
  assert.match(bootstrapScript, /mb --with-lock/);
  assert.match(bootstrapScript, /retention set --default governance 30d/);
  assert.match(bootstrapScript, /ilm rule add --expire-days 45/);
  const verifierScript =
    fixture.verifier.items[0].spec.template.spec.containers[0].command[2];
  assert.match(verifierScript, /if mc cp/);
  assert.match(verifierScript, /if mc rm/);
});

test('builds a constrained three-instance source cluster with one durable WAL authority', () => {
  const digest = `sha256:${'f'.repeat(64)}`;
  const fixture = postgresSourceFixtureResources({
    postgresImage: `registry:5000/ql3/postgresql@${digest}`,
  });
  const { cluster, backup } = fixture;
  assert.equal(cluster.spec.instances, 3);
  assert.equal(cluster.spec.enableSuperuserAccess, false);
  assert.equal(cluster.spec.imagePullPolicy, 'IfNotPresent');
  assert.equal(cluster.spec.plugins.length, 1);
  assert.deepEqual(cluster.spec.plugins[0], {
    name: 'barman-cloud.cloudnative-pg.io',
    isWALArchiver: true,
    parameters: { barmanObjectName: 'ql3-postgres-backup' },
  });
  assert.equal(cluster.spec.backup, undefined);
  assert.equal(
    cluster.spec.postgresql.parameters.synchronous_commit,
    'remote_apply',
  );
  assert.deepEqual(cluster.spec.postgresql.synchronous, {
    method: 'any',
    number: 1,
    dataDurability: 'required',
    failoverQuorum: true,
  });
  assert.deepEqual(cluster.spec.affinity, {
    enablePodAntiAffinity: true,
    podAntiAffinityType: 'required',
    topologyKey: 'kubernetes.io/hostname',
  });
  assert.deepEqual(cluster.spec.resources.limits, {
    cpu: '1',
    memory: '512Mi',
  });
  assert.equal(cluster.spec.storage.size, '1Gi');
  assert.equal(cluster.spec.walStorage.size, '512Mi');
  assert.equal(backup.spec.method, 'plugin');
  assert.equal(backup.spec.target, 'prefer-standby');
  assert.equal(
    backup.spec.pluginConfiguration.name,
    'barman-cloud.cloudnative-pg.io',
  );
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /"kind":"Secret"/);
  assert.doesNotMatch(serialized, /"password":|secretKeyRef|secretAccessKey/);
  assert.throws(() =>
    postgresSourceFixtureResources({ postgresImage: 'postgres:latest' }),
  );
});

test('builds all production DatabaseRole credentials without plaintext serialization', () => {
  const credentials = Object.fromEntries(
    POSTGRES_ROLES.map((role, index) => [
      role,
      `${String(index).padStart(2, '0')}${'A'.repeat(32)}`,
    ]),
  );
  const resources = postgresRoleSecretResources(credentials);
  assert.equal(resources.kind, 'List');
  assert.equal(resources.items.length, POSTGRES_ROLES.length);
  assert.deepEqual(
    resources.items.map((secret) =>
      Buffer.from(secret.data.username, 'base64').toString('utf8'),
    ),
    POSTGRES_ROLES,
  );
  assert.ok(
    resources.items.every(
      (secret) =>
        secret.metadata.namespace === 'ql3-dr' &&
        secret.type === 'kubernetes.io/basic-auth',
    ),
  );
  const serialized = JSON.stringify(resources);
  for (const password of Object.values(credentials)) {
    assert.doesNotMatch(serialized, new RegExp(password));
  }
  assert.throws(() =>
    postgresRoleSecretResources({ ...credentials, unexpected: 'A'.repeat(32) }),
  );
});

test('builds a digest-bound non-root migration Job using the production CLI', () => {
  const digest = `sha256:${'7'.repeat(64)}`;
  const image = `ql3-barman-dr-123-abcdef-registry:5000/ql3/cluster-control@${digest}`;
  const job = postgresMigrationJobResource({ controlImage: image });
  const pod = job.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(job.metadata.namespace, 'ql3-dr');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(container.image, image);
  assert.equal(container.imagePullPolicy, 'IfNotPresent');
  assert.deepEqual(container.command, [
    'node',
    '/opt/qinglong/node_modules/@qinglong/cluster-postgres/dist/migration/migrationCli.js',
  ]);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal(
    container.env.find(({ name }) => name === 'QL3_POSTGRES_TLS_MODE').value,
    'verify-full',
  );
  assert.equal(
    container.env.find(({ name }) => name === 'QL3_POSTGRES_MIGRATION_PASSWORD')
      .valueFrom.secretKeyRef.name,
    'ql3-postgres-migration-auth',
  );
  assert.doesNotMatch(JSON.stringify(job), /ql3_migration_test|postgres:\/\//);
  assert.throws(() =>
    postgresMigrationJobResource({ controlImage: 'cluster-control:latest' }),
  );
});

test('builds a production application readiness probe for each isolated restore', () => {
  const digest = `sha256:${'6'.repeat(64)}`;
  const image = `ql3-barman-dr-123-abcdef-registry:5000/ql3/cluster-control@${digest}`;
  const pepper = Buffer.alloc(32, 5).toString('base64url');
  const resources = postgresRestoreApplicationProbeResources({
    clusterName: 'ql3-postgres-restore-latest',
    controlImage: image,
    apiCredentialPepper: pepper,
  });
  const secret = resources.items.find(({ kind }) => kind === 'Secret');
  const deployment = resources.items.find(({ kind }) => kind === 'Deployment');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(secret.metadata.name, 'ql3-dr-application-latest-security');
  assert.doesNotMatch(JSON.stringify(resources), new RegExp(pepper));
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(container.image, image);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(
    container.env.find(({ name }) => name === 'QL3_WORKER_INGRESS_ENABLED')
      .value,
    'false',
  );
  assert.equal(
    container.env.find(({ name }) => name === 'QL3_POSTGRES_RUNTIME_HOST')
      .value,
    'ql3-postgres-restore-latest-rw.ql3-dr.svc',
  );
  assert.equal(
    pod.volumes.find(({ name }) => name === 'postgres-ca').secret.secretName,
    'ql3-postgres-restore-latest-ca',
  );
  assert.equal(container.readinessProbe.httpGet.path, '/readyz');
  assert.throws(() =>
    postgresRestoreApplicationProbeResources({
      clusterName: 'ql3-postgres',
      controlImage: image,
      apiCredentialPepper: pepper,
    }),
  );
});

test('requires the restored production application Pod to pass its real readiness probe', () => {
  const clusterName = 'ql3-postgres-restore-pitr';
  const name = 'ql3-dr-application-pitr';
  const deployment = {
    metadata: { name },
    spec: { replicas: 1 },
    status: { availableReplicas: 1, readyReplicas: 1 },
  };
  const pod = {
    metadata: {
      name: `${name}-abc`,
      labels: {
        'app.kubernetes.io/name': name,
        'ql3.cloud/restore-cluster': clusterName,
      },
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  };
  assert.equal(
    postgresRestoreApplicationRuntimeEvidence(deployment, [pod], clusterName)
      .ready,
    true,
  );
  assert.equal(
    postgresRestoreApplicationRuntimeEvidence(
      { ...deployment, status: { availableReplicas: 0, readyReplicas: 0 } },
      [pod],
      clusterName,
    ).ready,
    false,
  );
});

test('accepts only the complete production schema owner and non-elevated role catalog', () => {
  const roles = POSTGRES_ROLES.map((name) => ({
    name,
    login: true,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
  }));
  const input = {
    migrationCount: '52',
    controlCoreCapability: '51',
    databaseOwner: 'ql3_migration',
    postgresVersionNumber: '180004',
    roles,
  };
  const evidence = postgresDatabaseContractEvidence(input);
  assert.equal(evidence.migrationCount, 52);
  assert.equal(evidence.controlCoreCapability, 51);
  assert.equal(evidence.databaseOwner, 'ql3_migration');
  assert.equal(evidence.postgresVersionNumber, 180004);
  assert.deepEqual(
    evidence.roles.map(({ name }) => name),
    POSTGRES_ROLES,
  );
  assert.equal(Object.hasOwn(evidence.roles[0], 'login'), false);
  assert.throws(() =>
    postgresDatabaseContractEvidence({ ...input, migrationCount: 51 }),
  );
  assert.throws(() =>
    postgresDatabaseContractEvidence({
      ...input,
      roles: roles.map((role, index) =>
        index === 0 ? { ...role, superuser: true } : role,
      ),
    }),
  );
});

test('builds isolated latest and PITR restores from one read-only source authority', () => {
  const digest = `sha256:${'9'.repeat(64)}`;
  const postgresImage = `registry:5000/ql3/postgresql@${digest}`;
  const latest = postgresRestoreFixtureResources({
    postgresImage,
    clusterName: 'ql3-postgres-restore-latest',
  });
  const targetTime = '2026-08-04T00:00:00.123Z';
  const pitr = postgresRestoreFixtureResources({
    postgresImage,
    clusterName: 'ql3-postgres-restore-pitr',
    targetTime,
  });
  for (const restore of [latest, pitr]) {
    assert.equal(restore.spec.instances, 3);
    assert.equal(restore.spec.enableSuperuserAccess, false);
    assert.equal(restore.spec.plugins, undefined);
    assert.equal(
      restore.spec.postgresql.parameters.synchronous_commit,
      'remote_apply',
    );
    assert.equal(restore.spec.postgresql.synchronous.number, 1);
    assert.equal(restore.spec.affinity.podAntiAffinityType, 'required');
    assert.equal(restore.spec.externalClusters.length, 1);
    const plugin = restore.spec.externalClusters[0].plugin;
    assert.equal(plugin.name, 'barman-cloud.cloudnative-pg.io');
    assert.deepEqual(plugin.parameters, {
      barmanObjectName: 'ql3-postgres-recovery-source',
      serverName: 'ql3-postgres',
    });
  }
  assert.deepEqual(latest.spec.bootstrap.recovery, {
    source: 'ql3-postgres-origin',
  });
  assert.deepEqual(pitr.spec.bootstrap.recovery, {
    source: 'ql3-postgres-origin',
    recoveryTarget: { targetTime },
  });
  assert.throws(() =>
    postgresRestoreFixtureResources({
      postgresImage,
      clusterName: 'ql3-postgres',
    }),
  );
  assert.throws(() =>
    postgresRestoreFixtureResources({
      postgresImage,
      clusterName: 'ql3-postgres-restore-pitr',
    }),
  );
});

test('accepts only a three-node ready source cluster with a live primary', () => {
  const pod = (ordinal, node, ready = true) => ({
    metadata: {
      name: `ql3-postgres-${ordinal}`,
      labels: { 'cnpg.io/cluster': 'ql3-postgres' },
    },
    spec: { nodeName: node },
    status: {
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
    },
  });
  const cluster = {
    metadata: { name: 'ql3-postgres' },
    spec: { instances: 3 },
    status: { currentPrimary: 'ql3-postgres-1', readyInstances: 3 },
  };
  const pods = [pod(1, 'node-a'), pod(2, 'node-b'), pod(3, 'node-c')];
  const ready = postgresClusterRuntimeEvidence(cluster, pods);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.value.nodes, ['node-a', 'node-b', 'node-c']);
  assert.equal(
    postgresClusterRuntimeEvidence(cluster, [
      pods[0],
      pods[1],
      pod(3, 'node-b'),
    ]).ready,
    false,
  );
  assert.equal(
    postgresClusterRuntimeEvidence(
      { ...cluster, status: { ...cluster.status, readyInstances: 2 } },
      pods,
    ).ready,
    false,
  );
});

test('accepts only a completed plugin backup with bounded WAL evidence', () => {
  const completed = {
    status: {
      method: 'plugin',
      phase: 'completed',
      instanceID: { podName: 'ql3-postgres-2' },
      backupId: '20260804T010203',
      beginWal: '00000001000000000000000A',
      endWal: '00000001000000000000000B',
      startedAt: '2026-08-04T01:02:03Z',
      stoppedAt: '2026-08-04T01:02:05Z',
    },
  };
  const result = backupRuntimeEvidence(completed);
  assert.equal(result.ready, true);
  assert.equal(result.value.method, 'plugin');
  assert.equal(
    backupRuntimeEvidence({
      status: { ...completed.status, method: 'barmanObjectStore' },
    }).ready,
    false,
  );
  assert.equal(
    backupRuntimeEvidence({
      status: { ...completed.status, phase: 'failed' },
    }).ready,
    false,
  );
});

test('accepts certificate rotation only after serial, Secret and revision advance', () => {
  const previous = {
    serialSha256: `sha256:${'1'.repeat(64)}`,
    resourceVersion: '10',
  };
  const current = {
    serialSha256: `sha256:${'2'.repeat(64)}`,
    resourceVersion: '12',
  };
  assert.deepEqual(certificateRotationEvidence(previous, current, 1, 2), {
    previousSerialSha256: previous.serialSha256,
    currentSerialSha256: current.serialSha256,
    previousSecretResourceVersion: '10',
    currentSecretResourceVersion: '12',
  });
  assert.throws(() => certificateRotationEvidence(previous, previous, 1, 2));
  assert.throws(() => certificateRotationEvidence(previous, current, 2, 2));
});

test('accepts WAL archiving only after a successful archived segment', () => {
  assert.deepEqual(
    postgresArchiverEvidence({
      archivedCount: '2',
      failedCount: '0',
      lastArchivedWal: '00000001000000000000000C',
      lastArchivedTime: '2026-08-04T01:02:06Z',
    }),
    {
      archivedCount: 2,
      failedCount: 0,
      lastArchivedWal: '00000001000000000000000C',
      lastArchivedTime: '2026-08-04T01:02:06Z',
    },
  );
  assert.throws(() =>
    postgresArchiverEvidence({
      archivedCount: '0',
      failedCount: '0',
      lastArchivedWal: '',
      lastArchivedTime: '',
    }),
  );
});

test('executes PostgreSQL evidence queries without a network credential', () => {
  const calls = [];
  const kubectl = (args, options) => {
    calls.push({ args, options });
    return { stdout: '{"ok":true}' };
  };
  assert.deepEqual(
    postgresQueryJson(
      kubectl,
      'ql3-dr',
      'ql3-postgres-1',
      `SELECT '{"ok":true}'`,
    ),
    { ok: true },
  );
  assert.equal(
    postgresSql(kubectl, 'ql3-dr', 'ql3-postgres-1', 'SELECT 1'),
    '{"ok":true}',
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--username'));
  assert.ok(calls[0].args.includes('postgres'));
  assert.equal(calls[0].args.includes('--password'), false);
  assert.deepEqual(calls[0].options, { capture: true, quiet: true });
  assert.throws(() =>
    postgresSql(kubectl, 'ql3-dr', 'unexpected-pod', 'SELECT 1'),
  );
});

test('distinguishes latest and PITR marker boundaries exactly', () => {
  assert.deepEqual(
    restoreMarkerEvidence(
      { beforeMarkerPresent: true, afterMarkerPresent: true },
      true,
    ),
    { beforeMarkerPresent: true, afterMarkerPresent: true },
  );
  assert.deepEqual(
    restoreMarkerEvidence(
      { beforeMarkerPresent: true, afterMarkerPresent: false },
      false,
    ),
    { beforeMarkerPresent: true, afterMarkerPresent: false },
  );
  assert.throws(() =>
    restoreMarkerEvidence(
      { beforeMarkerPresent: false, afterMarkerPresent: false },
      false,
    ),
  );
});

test('accepts only content-free UUID, timestamp and WAL marker evidence', () => {
  assert.deepEqual(
    postgresMarkerEvidence({
      id: '123e4567-e89b-42d3-a456-426614174001',
      createdAt: '2026-08-04T01:02:03.123456Z',
      wal: '00000001000000000000000D',
    }),
    {
      id: '123e4567-e89b-42d3-a456-426614174001',
      createdAt: '2026-08-04T01:02:03.123456Z',
      wal: '00000001000000000000000D',
    },
  );
  assert.throws(() =>
    postgresMarkerEvidence({
      id: 'before-base-backup',
      createdAt: '2026-08-04T01:02:03Z',
      wal: 'not-wal',
    }),
  );
  assert.throws(() => auditedCloudNativePgDrEvidence({}));
});

test('keeps the destructive live path opt-in and isolated by prefix', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'scripts/ql3-cloudnativepg-barman-live-contract.cjs'),
    'utf8',
  );
  assert.match(source, /QL3_CLOUDNATIVEPG_BARMAN_LIVE !== '1'/);
  assert.ok(
    source.indexOf('  assertCloudNativePgDrRunnerCapacity();') <
      source.indexOf('  const temporary = fs.mkdtempSync('),
  );
  assert.match(source, /ql3-barman-dr-/);
  assert.doesNotMatch(source, /ql3-cnpg-evidence-control-plane/);
  assert.doesNotMatch(source, /apiservice\/v1\.webhook\.cert-manager\.io/);
  assert.match(
    source,
    /imagePullPolicy: Always'[\s\S]{0,80}imagePullPolicy: IfNotPresent'/,
  );
  assert.match(source, /registry:2@sha256:[a-f0-9]{64}/);
  assert.match(source, /skopeo\/stable:v1\.20\.0@sha256:[a-f0-9]{64}/);
  assert.match(source, /Docker-Content-Digest|inspection\.Digest/);
  assert.doesNotMatch(source, /imagePullPolicy: Never/);
  assert.doesNotMatch(source, /'images',\s*'import'/);
  assert.doesNotMatch(source, /reviewed-images\.tar/);
  assert.match(source, /run\(docker, \['rm', '-f', '-v', container\], \{/);
  assert.doesNotMatch(source, /run\(docker, \['rm', '-f', container\], \{/);
  assert.match(source, /REGISTRY_DATA_TARGETS = Object\.freeze/);
  assert.match(source, /K3S_DATA_TARGETS = Object\.freeze/);
  assert.match(
    source,
    /io\.qinglong\.ql3\.live=cloudnativepg-barman-disaster-recovery/,
  );
  assert.match(source, /io\.qinglong\.ql3\.run/);
  assert.match(source, /\['network', 'create', \.\.\.dockerLabels, network\]/);
  assert.match(
    source,
    /privateDockerDataBindArgs\(\s*dockerDataRoot,\s*registry,\s*REGISTRY_DATA_TARGETS/,
  );
  assert.match(
    source,
    /privateDockerDataBindArgs\(dockerDataRoot, node, K3S_DATA_TARGETS\)/,
  );
  assert.match(source, /pg_stat_archiver/);
  assert.match(source, /SELECT pg_switch_wal\(\)/);
  assert.match(source, /backupRuntimeEvidence/);
  assert.match(source, /plugin-barman-cloud/);
  assert.match(source, /prefer-standby backup unexpectedly ran on the primary/);
  assert.match(source, /privateKey: \{ rotationPolicy: 'Always' \}/);
  assert.match(source, /Barman mutual TLS certificate rotation/);
  assert.match(source, /post-rotation plugin base backup completion/);
  assert.match(source, /database-roles\.yaml/);
  assert.match(
    source,
    /@qinglong\/cluster-postgres\/dist\/migration\/migrationCli\.js/,
  );
  assert.match(source, /"event":"migration_completed"/);
  assert.match(source, /ALTER DATABASE qinglong OWNER TO ql3_migration/);
  assert.match(source, /postgresDatabaseContractEvidence/);
  assert.match(source, /production application readiness/);
  assert.match(source, /latestApplicationRtoSeconds/);
  assert.match(source, /pitrApplicationRtoSeconds/);
  assert.match(source, /ql3-postgres-restore-latest/);
  assert.match(source, /ql3-postgres-restore-pitr/);
  assert.match(source, /sourceClusterAfterRestores\.metadata\.uid/);
  assert.match(source, /cloudnativepg-disaster-recovery@v1/);
  assert.match(source, /auditedCloudNativePgDrEvidence/);
  assert.match(source, /schemaAndRoles: true/);
  assert.equal(
    source.match(/`eviction-hard=\$\{K3S_EVICTION_HARD\}`/g)?.length,
    2,
  );
  assert.match(
    source,
    /memory\.available<100Mi,nodefs\.available<64Mi,imagefs\.available<64Mi,nodefs\.inodesFree<1%/,
  );
});
