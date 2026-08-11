const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  auditCloudNativePgBackup,
} = require('../../scripts/ql3-cloudnativepg-backup-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

function intercept(relativePath, transform) {
  const target = path.join(ROOT, relativePath);
  return (filePath, encoding) => {
    const source = fs.readFileSync(filePath, encoding);
    return path.resolve(filePath) === target ? transform(source) : source;
  };
}

test('accepts isolated CNPG-I WAL, backup and restore contracts', () => {
  const report = auditCloudNativePgBackup({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.plugin, 'barman-cloud.cloudnative-pg.io');
  assert.equal(report.sourceCluster, 'ql3-postgres');
  assert.equal(report.restoreCluster, 'ql3-postgres-restore');
  assert.equal(report.retentionPolicy, '30d');
});

test('rejects deprecated in-tree backup or multiple WAL authorities', () => {
  const report = auditCloudNativePgBackup({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/barman-cloud-backup/cluster-plugin-patch.yaml',
      (source) =>
        `${source.replace(
          'name: barman-cloud.cloudnative-pg.io',
          'name: unreviewed.example',
        )}\n  backup:\n    retentionPolicy: 30d\n`,
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_WAL_ARCHIVER',
    ),
    true,
  );
});

test('rejects primary-only or implicit backup methods', () => {
  const report = auditCloudNativePgBackup({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/barman-cloud-backup/scheduled-backup.yaml',
      (source) =>
        source
          .replace('target: prefer-standby', 'target: primary')
          .replace('method: plugin', 'method: barmanObjectStore'),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_BASE_BACKUP_SCHEDULE',
    ),
    true,
  );
});

test('rejects plaintext endpoints, embedded credentials or missing retention', () => {
  const report = auditCloudNativePgBackup({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/barman-cloud-backup/object-store.s3.example.yaml',
      (source) =>
        source
          .replace('retentionPolicy: 30d', 'retentionPolicy: 1d')
          .replace('https://REPLACE_WITH_', 'http://REPLACE_WITH_')
          .replace(
            '  configuration:',
            '  stringData:\n    password: embedded\n  configuration:',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CNPG_OBJECT_STORE_CONTRACT' ||
        candidate.code === 'QL3_CNPG_OBJECT_STORE_SECRET_BOUNDARY',
    ),
    true,
  );
});

test('rejects in-place recovery or empty-WAL-archive bypass', () => {
  const report = auditCloudNativePgBackup({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg-restore/restore-cluster.yaml',
      (source) =>
        source
          .replace('name: ql3-postgres-restore', 'name: ql3-postgres')
          .replace(
            '  labels:',
            '  annotations:\n    cnpg.io/skipEmptyWalArchiveCheck: enabled\n  labels:',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_RESTORE_ISOLATION',
    ),
    true,
  );
});

test('rejects source ObjectStore reuse as restored-cluster WAL destination', () => {
  const report = auditCloudNativePgBackup({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg-restore/restore-cluster.yaml',
      (source) =>
        source.replace(
          '  postgresql:',
          '  plugins:\n    - name: barman-cloud.cloudnative-pg.io\n      isWALArchiver: true\n      parameters:\n        barmanObjectName: ql3-postgres-recovery-source\n  postgresql:',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_RESTORE_ISOLATION',
    ),
    true,
  );
});

test('rejects legacy serverName authority inside the recovery ObjectStore', () => {
  const report = auditCloudNativePgBackup({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg-restore/object-store.s3.example.yaml',
      (source) =>
        source.replace(
          '    s3Credentials:',
          '    serverName: ql3-postgres\n    s3Credentials:',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_RECOVERY_SOURCE',
    ),
    true,
  );
});
