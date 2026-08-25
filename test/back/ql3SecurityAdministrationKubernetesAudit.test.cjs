const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  auditSecurityAdministrationKubernetes,
} = require('../../scripts/ql3-security-administration-kubernetes-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

function intercept(relativePath, transform) {
  const target = path.join(ROOT, relativePath);
  return (filePath, encoding) => {
    const value = fs.readFileSync(filePath, encoding);
    return path.resolve(filePath) === target ? transform(value) : value;
  };
}

test('accepts the opt-in one-shot security administration deployment', () => {
  const report = auditSecurityAdministrationKubernetes({ root: ROOT });

  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.executionModel, 'opt-in-caller-driven-one-shot');
  assert.equal(report.residentResourceOverhead, 'zero');
  assert.equal(report.databaseConnectionsPerExecution, 1);
});

test('rejects Kubernetes API token authority in the administration Job', () => {
  const report = auditSecurityAdministrationKubernetes({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/security-administration/base/job.yaml',
      (value) =>
        value.replace(
          'automountServiceAccountToken: false',
          'automountServiceAccountToken: true',
        ),
    ),
  });

  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) =>
        code === 'QL3_SECURITY_ADMIN_KUBERNETES_API_AUTHORITY_INVALID',
    ),
  );
});

test('rejects recursive fsGroup rewrites of persistent credential custody', () => {
  const report = auditSecurityAdministrationKubernetes({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/security-administration/base/job.yaml',
      (value) => value.replace(
        'fsGroupChangePolicy: OnRootMismatch',
        'fsGroupChangePolicy: Always',
      ),
    ),
  });

  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) => code === 'QL3_SECURITY_ADMIN_KUBERNETES_JOB_BOUNDARY_INVALID',
    ),
  );
});

test('rejects a non-persistent credential delivery boundary', () => {
  const report = auditSecurityAdministrationKubernetes({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/security-administration/credential-delivery/component/job-patch.yaml',
      (value) => value.replace('persistentVolumeClaim:', 'emptyDir:'),
    ),
  });

  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) => code === 'QL3_SECURITY_ADMIN_KUBERNETES_DELIVERY_INVALID',
    ),
  );
});

test('rejects accidental installation in the shared cluster aggregate', () => {
  const report = auditSecurityAdministrationKubernetes({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      (value) => `${value}  - security-administration/base\n`,
    ),
  });

  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) => code === 'QL3_SECURITY_ADMIN_KUBERNETES_OPT_IN_INVALID',
    ),
  );
});
