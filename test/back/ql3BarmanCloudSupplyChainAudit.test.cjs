const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  auditBarmanCloudSupplyChain,
} = require('../../scripts/ql3-barman-cloud-supply-chain-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');
const LOCK =
  'deploy/kubernetes/ql3-cluster/operators/barman-cloud/plugin-lock.json';

function mutateLock(transform) {
  const target = path.join(ROOT, LOCK);
  return (filePath, encoding) => {
    const source = fs.readFileSync(filePath, encoding);
    if (path.resolve(filePath) !== target) return source;
    return JSON.stringify(transform(JSON.parse(source)));
  };
}

test('accepts the exact Barman candidate lock while preserving release blockers', () => {
  const report = auditBarmanCloudSupplyChain({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.pluginVersion, '0.13.0');
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.releaseBlockers, [
    'live-object-store-backup-wal-latest-restore-pitr-evidence',
  ]);
});

test('rejects a movable or drifted controller image', () => {
  const report = auditBarmanCloudSupplyChain({
    root: ROOT,
    readFile: mutateLock((lock) => {
      lock.plugin.controller.image =
        'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0';
      return lock;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_BARMAN_CONTROLLER_IMAGE',
    ),
    true,
  );
});

test('rejects a sidecar platform digest drift', () => {
  const report = auditBarmanCloudSupplyChain({
    root: ROOT,
    readFile: mutateLock((lock) => {
      lock.plugin.sidecar.platforms['linux/arm64'] = `sha256:${'0'.repeat(64)}`;
      return lock;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_BARMAN_SIDECAR_IMAGE',
    ),
    true,
  );
});

test('rejects an unverified release asset', () => {
  const report = auditBarmanCloudSupplyChain({
    root: ROOT,
    readFile: mutateLock((lock) => {
      lock.plugin.releaseManifestSha256 = 'unverified';
      return lock;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_BARMAN_RELEASE_ASSET',
    ),
    true,
  );
});

test('rejects certificate authority supply-chain status drift', () => {
  const report = auditBarmanCloudSupplyChain({
    root: ROOT,
    readFile: mutateLock((lock) => {
      lock.certificateAuthority.status = 'selected-unverified';
      return lock;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_BARMAN_CERTIFICATE_GATE',
    ),
    true,
  );
});

test('rejects premature release readiness or an unreviewed installer', () => {
  const readiness = auditBarmanCloudSupplyChain({
    root: ROOT,
    readFile: mutateLock((lock) => {
      lock.releaseReady = true;
      lock.releaseBlockers = [];
      return lock;
    }),
  });
  assert.equal(
    readiness.findings.some(
      (candidate) => candidate.code === 'QL3_BARMAN_PREMATURE_RELEASE',
    ),
    true,
  );

  const installer = auditBarmanCloudSupplyChain({
    root: ROOT,
    readDirectory: () => ['plugin-lock.json', 'manifest.yaml'],
  });
  assert.equal(
    installer.findings.some(
      (candidate) => candidate.code === 'QL3_BARMAN_INSTALLER_UNREVIEWED',
    ),
    true,
  );
});
