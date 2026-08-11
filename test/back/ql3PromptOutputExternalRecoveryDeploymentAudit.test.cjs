const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  auditPromptOutputExternalRecoveryDeployment,
} = require('../../scripts/ql3-prompt-output-external-recovery-deployment-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

function intercept(relativePath, transform) {
  const target = path.join(ROOT, relativePath);
  return (filePath, encoding) => {
    const source = fs.readFileSync(filePath, encoding);
    return path.resolve(filePath) === target ? transform(source) : source;
  };
}

test('accepts the tokenless offline recovery verifier deployment', () => {
  const report = auditPromptOutputExternalRecoveryDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.network, 'deny-all');
  assert.equal(report.databaseAuthority, false);
  assert.equal(report.kubernetesApiAuthority, false);
  assert.equal(report.kmsAuthority, false);
  assert.equal(report.workspaceReadOnly, true);
});

test('rejects token, credential, network or writable workspace authority', () => {
  const job =
    'deploy/kubernetes/ql3-cluster/operations/prompt-output-external-recovery/base/job.yaml';
  for (const transform of [
    (source) =>
      source.replace(
        'automountServiceAccountToken: false',
        'automountServiceAccountToken: true',
      ),
    (source) =>
      source.replace(
        '          resources:',
        '          env:\n            - name: AWS_SECRET_ACCESS_KEY\n              value: forbidden\n          resources:',
      ),
    (source) =>
      source.replace(
        '              readOnly: true',
        '              readOnly: false',
      ),
    (source) =>
      source.replace(
        '            readOnly: true',
        '            readOnly: false',
      ),
  ]) {
    const report = auditPromptOutputExternalRecoveryDeployment({
      root: ROOT,
      readFile: intercept(job, transform),
    });
    assert.equal(report.compatible, false);
    assert.ok(report.findings.some(({ code }) => code === 'QL3_RECOVERY_JOB'));
  }
});

test('rejects egress and any RBAC resource in the recovery base', () => {
  const networkReport = auditPromptOutputExternalRecoveryDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-external-recovery/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress: []',
          '  egress:\n    - to:\n        - ipBlock:\n            cidr: 0.0.0.0/0',
        ),
    ),
  });
  assert.equal(networkReport.compatible, false);
  assert.ok(
    networkReport.findings.some(
      ({ code }) => code === 'QL3_RECOVERY_NETWORK_POLICY',
    ),
  );

  const rbacReport = auditPromptOutputExternalRecoveryDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-external-recovery/base/kustomization.yaml',
      (source) => `${source}  - role.yaml\n`,
    ),
  });
  assert.equal(rbacReport.compatible, false);
  assert.ok(
    rbacReport.findings.some(
      ({ code }) => code === 'QL3_RECOVERY_KUSTOMIZATION',
    ),
  );
});

test('rejects command paths outside the isolated workspace', () => {
  const report = auditPromptOutputExternalRecoveryDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-external-recovery/command.example.json',
      (source) =>
        source.replace(
          '/var/run/qinglong3/prompt-output-external-recovery/artifact.json',
          '/var/run/secrets/kubernetes.io/serviceaccount/token',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(({ code }) => code === 'QL3_RECOVERY_COMMAND'),
  );
});
