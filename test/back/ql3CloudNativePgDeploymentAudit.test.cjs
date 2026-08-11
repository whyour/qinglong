const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  auditCloudNativePgDeployment,
} = require('../../scripts/ql3-cloudnativepg-deployment-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

function intercept(relativePath, transform) {
  const target = path.join(ROOT, relativePath);
  return (filePath, encoding) => {
    const source = fs.readFileSync(filePath, encoding);
    return path.resolve(filePath) === target ? transform(source) : source;
  };
}

test('accepts the locked CloudNativePG HA and authority profile', () => {
  const report = auditCloudNativePgDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.operatorVersion, '1.30.0');
  assert.equal(report.postgresqlVersion, '18.4');
  assert.equal(report.instances, 3);
  assert.deepEqual(report.roles, [
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
});

test('rejects a missing or rewritten operator release manifest digest', () => {
  for (const transform of [
    (source) => source.replace(/\s+"releaseManifestSha256": "[^"]+",/, ''),
    (source) =>
      source.replace(
        /"releaseManifestSha256": "[^"]+"/,
        `"releaseManifestSha256": "sha256:${'0'.repeat(64)}"`,
      ),
  ]) {
    const report = auditCloudNativePgDeployment({
      root: ROOT,
      readFile: intercept(
        'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/operator-lock.json',
        transform,
      ),
    });
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(({ code }) => code === 'QL3_CNPG_SUPPLY_CHAIN_LOCK'),
    );
  }
});

test('rejects a single instance or unpinned PostgreSQL operand', () => {
  const report = auditCloudNativePgDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/cluster.yaml',
      (source) =>
        source
          .replace('instances: 3', 'instances: 1')
          .replace(
            /imageName: .+/,
            'imageName: ghcr.io/cloudnative-pg/postgresql:18.4-minimal-trixie',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_CLUSTER_BASELINE',
    ),
    true,
  );
});

test('rejects a privileged database role', () => {
  const report = auditCloudNativePgDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/database-roles.yaml',
      (source) => source.replace('superuser: false', 'superuser: true'),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_DATABASE_ROLE',
    ),
    true,
  );
});

test('rejects runtime DSN authority or a non-primary endpoint', () => {
  const report = auditCloudNativePgDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/postgres-runtime-patch.yaml',
      (source) =>
        source
          .replace('$patch: delete', 'value: postgres://embedded-secret')
          .replace(
            'ql3-postgres-rw.qinglong3-system.svc',
            'ql3-postgres-ro.qinglong3-system.svc',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_RUNTIME_BINDING',
    ),
    true,
  );
});

test('rejects migration credentials or CA from the runtime domain', () => {
  const report = auditCloudNativePgDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg/migrate-job-patch.yaml',
      (source) =>
        source
          .replaceAll(
            'ql3-postgres-migration-auth',
            'ql3-postgres-runtime-auth',
          )
          .replace('value: ql3-postgres-ca', 'value: runtime-ca')
          .replace('value: ca.crt', 'value: postgres-ca.crt'),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_MIGRATION_BINDING',
    ),
    true,
  );
});

test('rejects a deployable tag or missing image transform in either application path', () => {
  for (const [relativePath, transform, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/kustomization.yaml',
      (source) =>
        source.replace(
          /\s+digest: sha256:[0-9a-f]{64}/,
          '\n    newTag: latest',
        ),
      'QL3_CNPG_RUNTIME_BINDING',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg/kustomization.yaml',
      (source) => source.replace(/\nimages:[\s\S]*?(?=\npatches:)/, '\n'),
      'QL3_CNPG_MIGRATION_BINDING',
    ],
  ]) {
    const report = auditCloudNativePgDeployment({
      root: ROOT,
      readFile: intercept(relativePath, transform),
    });
    assert.equal(report.compatible, false);
    assert.ok(report.findings.some(({ code }) => code === findingCode));
  }
});

test('rejects applying credential examples through kustomize', () => {
  const report = auditCloudNativePgDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/kustomization.yaml',
      (source) =>
        source.replace(
          '  - database.yaml',
          '  - database.yaml\n  - credentials.example.yaml',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CNPG_SECRET_APPLICATION_BOUNDARY',
    ),
    true,
  );
});
