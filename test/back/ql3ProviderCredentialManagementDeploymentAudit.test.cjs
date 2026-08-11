const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  auditProviderCredentialManagementDeployment,
} = require('../../scripts/ql3-provider-credential-management-deployment-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

test('provider credential management deployment is opt-in and least privilege', () => {
  const report = auditProviderCredentialManagementDeployment({ root: ROOT });
  assert.deepEqual(report.findings, []);
  assert.equal(report.compatible, true);
  assert.equal(report.manager, 'optional-tls13-mtls-oidc-https');
  assert.equal(report.client, 'caller-driven-one-shot');
  assert.equal(report.postgresAuthority, 'ql3_ai_credential_manager');
});

test('provider credential management deployment audit rejects widened database pools', () => {
  const target = path.join(
    ROOT,
    'deploy/kubernetes/ql3-cluster/operations/provider-credential-management/base/deployment.yaml',
  );
  const readFile = (filePath, encoding) => {
    const source = fs.readFileSync(filePath, encoding);
    return path.resolve(filePath) === target
      ? source.replace(
          "QL3_POSTGRES_AI_CREDENTIAL_MANAGER_POOL_MAX\n              value: '2'",
          "QL3_POSTGRES_AI_CREDENTIAL_MANAGER_POOL_MAX\n              value: '20'",
        )
      : source;
  };
  const report = auditProviderCredentialManagementDeployment({
    root: ROOT,
    readFile,
  });
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) => code === 'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_ENV_INVALID',
    ),
  );
});
