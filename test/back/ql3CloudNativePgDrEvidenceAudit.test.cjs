const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const {
  validateCloudNativePgDrEvidence,
  validateCloudNativePgDrReleaseEvidence,
} = require('../../scripts/ql3-cloudnativepg-dr-evidence-audit.cjs');
const {
  parseArguments: parseReleaseGateArguments,
} = require('../../scripts/ql3-cloudnativepg-dr-release-gate.cjs');

const SOURCE_REVISION = 'a'.repeat(40);

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function roles() {
  return [
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
  ].map((name) => ({
    name,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
  }));
}

function restore(cluster, afterMarkerPresent) {
  return {
    cluster,
    sourceObjectStore: 'ql3-postgres-recovery-source',
    sourceServerName: 'ql3-postgres',
    sourceClusterUnmodified: true,
    targetWalArchiver: false,
    instances: 3,
    ready: true,
    migrationCount: 54,
    controlCoreCapability: 53,
    databaseOwner: 'ql3_migration',
    synchronousCommit: 'remote_apply',
    synchronousStandbys: 1,
    roles: roles(),
    beforeMarkerPresent: true,
    afterMarkerPresent,
  };
}

function validReport() {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/cloudnativepg-disaster-recovery@v1',
    observedAt: '2026-07-24T12:30:00.000Z',
    sourceRevision: SOURCE_REVISION,
    platform: {
      kubernetesVersion: '1.32.8',
      architecture: 'amd64',
      cloudNativePgVersion: '1.30.0',
      cloudNativePgImageId: hash('1'),
      postgresVersionNumber: 180004,
      postgresImageId: hash('2'),
      barmanVersion: '0.13.0',
      barmanControllerImageId:
        'sha256:417449fe4f6f0a56acdeb30e4131930815f2b46b9afeb808059b57aa8b4c2ef5',
      barmanSidecarImageIds: [
        'sha256:15cb1a01e7c5235eedac2061cab8208e5f7c39dbda292f9c2d4ddaa0c1f211e6',
        'sha256:15cb1a01e7c5235eedac2061cab8208e5f7c39dbda292f9c2d4ddaa0c1f211e6',
        'sha256:15cb1a01e7c5235eedac2061cab8208e5f7c39dbda292f9c2d4ddaa0c1f211e6',
      ],
      certManagerVersion: '1.20.3',
      certManagerImageIds: [
        'sha256:1e4af57beb469cc3bb0fb48b9201caea2723819b9ffd3c3ea98568f55b4dd38b',
        'sha256:a2b12d27950d1603d2c8168c3ccd95d07b93ce6ec4b530316196a31db592a9c0',
        'sha256:953a97df613f7da7eda8ce4b1c8d8e6b50963db0800fab595d040db6eb5cb060',
      ],
    },
    source: {
      cluster: 'ql3-postgres',
      backup: {
        name: 'ql3-dr-backup-20260724',
        phase: 'completed',
        startedAt: '2026-07-24T12:00:00.000Z',
        completedAt: '2026-07-24T12:05:00.000Z',
        beginWal: '000000010000000000000001',
        endWal: '000000010000000000000002',
      },
      markers: {
        before: {
          id: '123e4567-e89b-42d3-a456-426614174001',
          createdAt: '2026-07-24T12:01:00.000Z',
          wal: '000000010000000000000001',
        },
        after: {
          id: '123e4567-e89b-42d3-a456-426614174002',
          createdAt: '2026-07-24T12:10:00.000Z',
          wal: '000000010000000000000003',
        },
      },
      wal: {
        archiveHealthy: true,
        continuous: true,
        noGaps: true,
        lastArchivedWal: '000000010000000000000004',
      },
    },
    latestRestore: restore('ql3-postgres-restore-latest', true),
    pitrRestore: {
      ...restore('ql3-postgres-restore-pitr', false),
      targetTime: '2026-07-24T12:06:00.000Z',
    },
    certificateRotation: {
      client: {
        previousSerialSha256: hash('7'),
        currentSerialSha256: hash('8'),
        previousSecretResourceVersion: '101',
        currentSecretResourceVersion: '102',
      },
      server: {
        previousSerialSha256: hash('9'),
        currentSerialSha256: hash('a'),
        previousSecretResourceVersion: '201',
        currentSecretResourceVersion: '202',
      },
      walArchivedDuringRotation: true,
      backupCompletedAfterRotation: true,
      latestRestoreCompletedAfterRotation: true,
      pitrCompletedAfterRotation: true,
      maxObservedInterruptionSeconds: 2.4,
    },
    objectStoreAuthority: {
      sourceObjectStore: 'ql3-postgres-backup',
      recoveryObjectStore: 'ql3-postgres-recovery-source',
      sourceWriterIdentitySha256: hash('b'),
      recoveryReaderIdentitySha256: hash('c'),
      recoveryReadOnly: true,
      versioning: true,
      immutability: true,
      lifecycleDays: 30,
    },
    serviceLevels: {
      targetMaxRpoSeconds: 60,
      observedRpoSeconds: 5,
      targetMaxDatabaseRtoSeconds: 1200,
      latestDatabaseRtoSeconds: 410,
      pitrDatabaseRtoSeconds: 470,
      targetMaxApplicationRtoSeconds: 1800,
      latestApplicationRtoSeconds: 520,
      pitrApplicationRtoSeconds: 590,
    },
    gates: {
      latestRestore: true,
      pointInTimeRestore: true,
      schemaAndRoles: true,
      sourceIsolation: true,
      certificateRotation: true,
      serviceLevels: true,
      passed: true,
    },
  };
}

test('accepts complete latest, PITR, rotation and service-level evidence', () => {
  const report = validateCloudNativePgDrEvidence(validReport());
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
});

test('accepts fresh disaster-recovery evidence bound to the release source', () => {
  const report = validateCloudNativePgDrReleaseEvidence(validReport(), {
    sourceCommit: SOURCE_REVISION,
    releaseVersion: '3.0.0-rc.1',
    nowMs: Date.parse('2026-07-24T13:00:00.000Z'),
  });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.maximumAgeSeconds, 86_400);
});

test('rejects stale or source-detached disaster-recovery release evidence', () => {
  const report = validateCloudNativePgDrReleaseEvidence(validReport(), {
    sourceCommit: 'b'.repeat(40),
    releaseVersion: '3.0.0',
    nowMs: Date.parse('2026-07-26T12:30:01.000Z'),
  });
  assert.equal(
    report.findings.some(({ code }) => code === 'QL3_DR_RELEASE_SOURCE'),
    true,
  );
  assert.equal(
    report.findings.some(({ code }) => code === 'QL3_DR_RELEASE_FRESHNESS'),
    true,
  );
});

test('release gate accepts only one exact private-report argument set', () => {
  assert.deepEqual(
    parseReleaseGateArguments([
      '--report=/run/qinglong3-release-evidence/a/report.json',
      `--source-commit=${SOURCE_REVISION}`,
      '--release-version=3.0.0',
    ]),
    {
      reportPath: '/run/qinglong3-release-evidence/a/report.json',
      sourceCommit: SOURCE_REVISION,
      releaseVersion: '3.0.0',
    },
  );
  assert.throws(
    () =>
      parseReleaseGateArguments([
        '--report=relative.json',
        `--source-commit=${SOURCE_REVISION}`,
        '--release-version=3.0.0',
      ]),
    /must be absolute/,
  );
});

test('release gate CLI accepts a fresh private regular report', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-dr-release-gate-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o700);

  const report = validReport();
  report.observedAt = new Date().toISOString();
  const reportPath = path.join(directory, 'cloudnativepg-dr-evidence.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });

  const output = execFileSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-cloudnativepg-dr-release-gate.cjs',
      ),
      `--report=${reportPath}`,
      `--source-commit=${SOURCE_REVISION}`,
      '--release-version=3.0.0-rc.1',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(output).compatible, true);

  fs.chmodSync(reportPath, 0o700);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.resolve(
            __dirname,
            '../../scripts/ql3-cloudnativepg-dr-release-gate.cjs',
          ),
          `--report=${reportPath}`,
          `--source-commit=${SOURCE_REVISION}`,
          '--release-version=3.0.0-rc.1',
        ],
        { encoding: 'utf8' },
      ),
    /mode-0600 regular file/,
  );
});

test('rejects a restore report pinned to the obsolete schema and role set', () => {
  const input = validReport();
  input.latestRestore.migrationCount = 17;
  input.latestRestore.controlCoreCapability = 16;
  input.latestRestore.roles = input.latestRestore.roles.filter(
    ({ name }) =>
      !name.startsWith('ql3_worker_credential_') &&
      name !== 'ql3_automation_manager',
  );
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(({ code }) => code === 'QL3_DR_LATEST_RESTORE'),
    true,
  );
});

test('rejects credential or private material in the report', () => {
  const input = validReport();
  input.objectStoreAuthority.password = 'must-not-appear';
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_SECRET_EXPOSURE',
    ),
    true,
  );
});

test('rejects latest restore without both durable markers', () => {
  const input = validReport();
  input.latestRestore.afterMarkerPresent = false;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_LATEST_RESTORE',
    ),
    true,
  );
});

test('rejects PITR outside the marker window or containing the later marker', () => {
  const input = validReport();
  input.pitrRestore.targetTime = '2026-07-24T12:11:00.000Z';
  input.pitrRestore.afterMarkerPresent = true;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_PITR_RESTORE',
    ),
    true,
  );
});

test('rejects schema, role or restored-cluster write-authority drift', () => {
  const input = validReport();
  input.latestRestore.controlCoreCapability = 15;
  input.latestRestore.roles[0].superuser = true;
  input.latestRestore.targetWalArchiver = true;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_LATEST_RESTORE',
    ),
    true,
  );
});

test('rejects shared object-store identities or weakened retention', () => {
  const input = validReport();
  input.objectStoreAuthority.recoveryReaderIdentitySha256 =
    input.objectStoreAuthority.sourceWriterIdentitySha256;
  input.objectStoreAuthority.lifecycleDays = 7;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_OBJECT_STORE_AUTHORITY',
    ),
    true,
  );
});

test('rejects certificate rotation without new identities and continued recovery', () => {
  const input = validReport();
  input.certificateRotation.client.currentSerialSha256 =
    input.certificateRotation.client.previousSerialSha256;
  input.certificateRotation.pitrCompletedAfterRotation = false;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_CERTIFICATE_ROTATION',
    ),
    true,
  );
});

test('rejects observed RPO or RTO above deployment targets', () => {
  const input = validReport();
  input.serviceLevels.observedRpoSeconds = 61;
  input.serviceLevels.pitrApplicationRtoSeconds = 1801;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_SERVICE_LEVELS',
    ),
    true,
  );
});

test('rejects a summary that hides an independently failed gate', () => {
  const input = validReport();
  input.gates.pointInTimeRestore = false;
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_GATE_SUMMARY',
    ),
    true,
  );
});

test('rejects cert-manager image count, order or digest drift', () => {
  const input = validReport();
  input.platform.certManagerImageIds[0] = hash('d');
  input.platform.certManagerImageIds.push(hash('e'));
  const report = validateCloudNativePgDrEvidence(input);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_DR_PLATFORM_PROVENANCE',
    ),
    true,
  );
});
