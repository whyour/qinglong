const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const producerPath = path.join(
  root,
  'scripts/ql3-plugin-package-recovery-e2e-live-contract.cjs',
);
const {
  CONTRACT_VERSION,
  FIXTURE,
  GATE_KEYS,
  MIGRATION_COUNT,
  readPrivateReport,
  validatePluginPackageRecoveryE2ELiveReport,
} = require('../../scripts/ql3-plugin-package-recovery-e2e-live-audit.cjs');
const {
  writePrivateReport,
  buildOrderingEvidence,
} = require('../../scripts/ql3-plugin-package-recovery-e2e-live-contract.cjs');

function validReport() {
  const admin = `sha256:${'a'.repeat(64)}`;
  const control = `sha256:${'b'.repeat(64)}`;
  const sourceRevision = 'c'.repeat(40);
  const lock = 'd'.repeat(64);
  return {
    schema: FIXTURE,
    observedAt: '2026-08-14T08:00:07.000Z',
    sourceRevision,
    passed: true,
    cluster: 'ql3-plugin-recovery-e2e-ci',
    architecture: 'arm64',
    elapsedMs: 420000,
    images: {
      adminBuildId: admin,
      adminSourceRevision: sourceRevision,
      controlBuildId: control,
      controlSourceRevision: sourceRevision,
      postgresRepositoryDigest:
        'postgres@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296',
      migrationImageId: `docker://${control}`,
      initialRecoveryImageId: `docker://${admin}`,
      upgradeRecoveryImageId: `docker://${admin}`,
      postgresImageId: `containerd://sha256:${'e'.repeat(64)}`,
    },
    ordering: {
      migrationJobUid: '00000000-0000-4000-8000-000000000001',
      migrationCompletedAt: '2026-08-14T08:00:01.000Z',
      initialRecoveryJobUid: '00000000-0000-4000-8000-000000000002',
      initialRecoveryCompletedAt: '2026-08-14T08:00:02.000Z',
      upgradeRecoveryJobUid: '00000000-0000-4000-8000-000000000003',
      upgradeRecoveryCompletedAt: '2026-08-14T08:00:03.000Z',
      runtimeCreatedAt: '2026-08-14T08:00:04.000Z',
      runtimeBoundRecoveryJobUid: '00000000-0000-4000-8000-000000000003',
    },
    failedUpgrade: {
      recoveryJobUid: '00000000-0000-4000-8000-000000000003',
      rejectionReason: 'activation_fact_conflict',
      candidateRevisionCount: 0,
      activePointerUnchanged: true,
    },
    database: {
      migrationCount: MIGRATION_COUNT,
      capabilityVersion: CONTRACT_VERSION,
      initialState: 'active',
      initialActiveLockDigest: lock,
      upgradeState: 'failed',
      upgradePreviousActiveLockDigest: lock,
      upgradeActiveLockDigest: lock,
      upgradeFailureReason: 'activation_fact_conflict',
      initialMutationCount: 4,
      upgradeMutationCount: 3,
      headInstallationId: 'install-plugin-recovery-e2e-upgrade',
      initialRevisionCount: 1,
      upgradeRevisionCount: 0,
      recoverableCount: 0,
    },
    oci: {
      https: true,
      authentication: 'exact-registry-basic',
      authenticatedRequestCount: 24,
      requestCount: 24,
      uniquePaths: 12,
      initialRequestCount: 12,
      upgradeRequestCount: 12,
      redirects: 0,
    },
    kubernetes: {
      activePointer: {
        name: 'ql3-plugin-package-active-e2e-monitor',
        uid: '00000000-0000-4000-8000-000000000006',
        resourceVersion: '42',
        activeJsonDigest: '1'.repeat(64),
        intentDigest: '2'.repeat(64),
        activationRef: 'activation-e2e-monitor-1',
      },
      rbac: {
        getConfigMaps: true,
        createConfigMaps: true,
        updateConfigMaps: true,
        listConfigMaps: false,
        deleteConfigMaps: false,
        getSecrets: false,
      },
    },
    runtime: {
      replicas: 2,
      creationTimestamp: '2026-08-14T08:00:04.000Z',
      recoveryJobUid: '00000000-0000-4000-8000-000000000003',
      recoveryCompletedAt: '2026-08-14T08:00:03.000Z',
      nodes: ['worker-a', 'worker-b'],
      imageIds: [`docker://${control}`],
    },
    gates: Object.fromEntries(GATE_KEYS.map((key) => [key, true])),
    limitations: [
      'isolated PostgreSQL uses explicit TLS disable; production manifests remain verify-full',
      'the authenticated HTTPS OCI Distribution fixture implements the immutable GET/referrers surface used by the resolver, not a production registry storage implementation',
      'the disposable Kind control plane is single-replica; this gate proves workload ordering, not Kubernetes control-plane HA',
    ],
  };
}

test('offline audit accepts one exact low-sensitive recovery report', () => {
  const result = validatePluginPackageRecoveryE2ELiveReport(validReport());
  assert.equal(result.compatible, true);
  assert.deepEqual(result.findings, []);
});

test('producer binds ordering to the recovery completion timestamp carried into runtime', () => {
  const ordering = buildOrderingEvidence(
    {
      metadata: { uid: 'migration-job' },
      status: { completionTime: '2026-08-14T08:00:01.000Z' },
    },
    {
      metadata: { uid: 'initial-recovery-job' },
      status: { completionTime: '2026-08-14T08:00:02.000Z' },
    },
    {
      metadata: { uid: 'upgrade-recovery-job' },
      status: { completionTime: '2026-08-14T08:00:03.000Z' },
    },
    {
      creationTimestamp: '2026-08-14T08:00:05.000Z',
      recoveryJobUid: 'upgrade-recovery-job',
      recoveryCompletedAt: '2026-08-14T08:00:04.000Z',
    },
  );
  assert.equal(
    ordering.upgradeRecoveryCompletedAt,
    '2026-08-14T08:00:04.000Z',
  );
  assert.equal(ordering.runtimeBoundRecoveryJobUid, 'upgrade-recovery-job');
});

test('offline audit rejects broken upgrade, ordering and image relationships', () => {
  const report = validReport();
  report.database.upgradeRevisionCount = 1;
  report.ordering.upgradeRecoveryCompletedAt =
    '2026-08-14T07:59:59.000Z';
  report.images.initialRecoveryImageId = `docker://${report.images.controlBuildId}`;
  report.runtime.imageIds = [`docker://sha256:${'9'.repeat(64)}`];
  report.gates.activePointerJsonUnchanged = false;
  const codes = validatePluginPackageRecoveryE2ELiveReport(report).findings.map(
    (value) => value.code,
  );
  assert.ok(codes.includes('QL3_PLUGIN_RECOVERY_E2E_DATABASE'));
  assert.ok(codes.includes('QL3_PLUGIN_RECOVERY_E2E_ORDERING'));
  assert.ok(codes.includes('QL3_PLUGIN_RECOVERY_E2E_IMAGES'));
  assert.ok(codes.includes('QL3_PLUGIN_RECOVERY_E2E_RUNTIME'));
  assert.ok(codes.includes('QL3_PLUGIN_RECOVERY_E2E_GATES'));
});

test('offline audit rejects forbidden keys and credential-shaped material', () => {
  const report = validReport();
  report.password = 'not-allowed';
  report.limitations[0] =
    'postgresql://operator:credential@database.example/qinglong';
  const result = validatePluginPackageRecoveryE2ELiveReport(report);
  assert.equal(result.compatible, false);
  assert.ok(
    result.findings.some(
      (value) => value.code === 'QL3_PLUGIN_RECOVERY_E2E_SENSITIVE',
    ),
  );
});

test('producer writes an atomic owner-private no-replace report', (context) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-recovery-report-'),
  );
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const reportFile = path.join(temporary, 'report.json');
  writePrivateReport(reportFile, validReport());
  assert.equal(fs.statSync(reportFile).mode & 0o777, 0o600);
  assert.equal(readPrivateReport(reportFile).schema, FIXTURE);
  assert.deepEqual(
    fs.readdirSync(temporary).filter((value) => value.endsWith('.tmp')),
    [],
  );
  assert.throws(
    () => writePrivateReport(reportFile, validReport()),
    /EEXIST|exist/i,
  );
});

test('private report reader rejects relative, symlinked and broad-mode reports', (context) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-recovery-audit-'),
  );
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const reportFile = path.join(temporary, 'report.json');
  fs.writeFileSync(reportFile, '{}\n', { mode: 0o600 });
  assert.throws(() => readPrivateReport('report.json'), /absolute/);
  const link = path.join(temporary, 'link.json');
  fs.symlinkSync(reportFile, link);
  assert.throws(() => readPrivateReport(link), /owner-private/);
  fs.chmodSync(reportFile, 0o640);
  assert.throws(() => readPrivateReport(reportFile), /owner-private/);
});

test('producer refuses missing authority before invoking Docker or Kind', (context) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-recovery-producer-'),
  );
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const report = path.join(temporary, 'report.json');
  const noReport = spawnSync(process.execPath, [producerPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(noReport.status, 0);
  assert.match(noReport.stderr, /--report=\/absolute/);
  const noOptIn = spawnSync(
    process.execPath,
    [producerPath, `--report=${report}`],
    {
      cwd: root,
      env: { ...process.env, QL3_DOCKER_BIN: '/not/invoked/docker' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(noOptIn.status, 0);
  assert.match(noOptIn.stderr, /QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE=1/);
  const noRevision = spawnSync(
    process.execPath,
    [producerPath, `--report=${report}`],
    {
      cwd: root,
      env: {
        ...process.env,
        QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE: '1',
        QL3_KIND_BIN: '/not/invoked/kind',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(noRevision.status, 0);
  assert.match(noRevision.stderr, /QL3_SOURCE_REVISION/);
});
