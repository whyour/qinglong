const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  auditCertManagerSelection,
} = require('../../scripts/ql3-cert-manager-selection-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SELECTION =
  'deploy/kubernetes/ql3-cluster/operators/cert-manager/selection-lock.json';
const BARMAN =
  'deploy/kubernetes/ql3-cluster/operators/barman-cloud/plugin-lock.json';

function mutateJson(relativePath, transform) {
  const target = path.join(ROOT, relativePath);
  return (filePath, encoding) => {
    const source = fs.readFileSync(filePath, encoding);
    if (path.resolve(filePath) !== target) return source;
    return JSON.stringify(transform(JSON.parse(source)));
  };
}

test('accepts the supply-chain-verified cert-manager selection with live blockers', () => {
  const report = auditCertManagerSelection({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.certManagerVersion, '1.20.3');
  assert.equal(report.kubernetesVersion, '1.32.8');
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.releaseBlockers, [
    'live-cert-manager-api-and-plugin-mtls-rotation-evidence',
  ]);
});

test('rejects selecting a cert-manager minor outside the Kubernetes baseline', () => {
  const report = auditCertManagerSelection({
    root: ROOT,
    readFile: mutateJson(SELECTION, (selection) => {
      selection.certManager.version = '1.21.0';
      return selection;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CERT_MANAGER_SELECTION',
    ),
    true,
  );
});

test('rejects widening or hiding the Kubernetes support boundary', () => {
  const report = auditCertManagerSelection({
    root: ROOT,
    readFile: mutateJson(SELECTION, (selection) => {
      selection.compatibility.supportedKubernetesMin = '1.33';
      return selection;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CERT_MANAGER_KUBERNETES_COMPATIBILITY',
    ),
    true,
  );
});

test('rejects pretending the live evidence gate is release-ready', () => {
  const report = auditCertManagerSelection({
    root: ROOT,
    readFile: mutateJson(SELECTION, (selection) => {
      selection.releaseReady = true;
      selection.releaseBlockers = [];
      return selection;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CERT_MANAGER_PREMATURE_RELEASE',
    ),
    true,
  );
});

test('rejects certificate identity, usage or namespace drift', () => {
  const report = auditCertManagerSelection({
    root: ROOT,
    readFile: mutateJson(SELECTION, (selection) => {
      selection.pluginTls.certificates[1].dnsNames = ['unreviewed'];
      return selection;
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CERT_MANAGER_PLUGIN_TLS',
    ),
    true,
  );
});

test('rejects Barman binding drift or an unverified installer', () => {
  const binding = auditCertManagerSelection({
    root: ROOT,
    readFile: mutateJson(BARMAN, (lock) => {
      lock.certificateAuthority.version = 'latest';
      return lock;
    }),
  });
  assert.equal(
    binding.findings.some(
      (candidate) => candidate.code === 'QL3_CERT_MANAGER_BARMAN_BINDING',
    ),
    true,
  );

  const installer = auditCertManagerSelection({
    root: ROOT,
    readDirectory: () => ['selection-lock.json', 'manifest.yaml'],
  });
  assert.equal(
    installer.findings.some(
      (candidate) => candidate.code === 'QL3_CERT_MANAGER_INSTALLER_UNVERIFIED',
    ),
    true,
  );
});
