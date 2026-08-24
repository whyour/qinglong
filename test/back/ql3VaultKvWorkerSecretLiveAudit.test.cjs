'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  IMAGE,
  REQUIRED_GATES,
  validateVaultKvWorkerSecretLiveReport,
} = require('../../scripts/ql3-vault-kv-worker-secret-live-audit.cjs');

function fixture() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    platform: {
      architecture: 'arm64',
      vaultImage: IMAGE,
      vaultImageId: `sha256:${'a'.repeat(64)}`,
      vaultVersion: '1.20.2',
      transport: 'TLSv1.3 with an explicit private CA',
      storage: 'persistent file barrier fixture',
    },
    custody: {
      provider: 'vault-kv-v2',
      kvVersion: 2,
      policyCount: 1,
      maximumTokenTtlSeconds: 900,
      tokenLeaseSeconds: 600,
      secretCount: 2,
      environmentBundleCount: 1,
      observedVersions: [1, 2],
      containerReplacements: 1,
    },
    gates: Object.fromEntries(REQUIRED_GATES.map((gate) => [gate, true])),
    limitations: [
      'single-host file storage is not Vault integrated-storage HA or an HSM seal quorum',
      'the short-lived private CA and service tokens are fixture authorities rather than enterprise PKI',
      'the live gate proves direct custody resolution rather than physical Edge storage behavior',
    ],
  };
}

test('accepts the exact content-free Vault KV direct custody report', () => {
  assert.deepEqual(validateVaultKvWorkerSecretLiveReport(fixture()), {
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: [],
    compatible: true,
  });
});

test('rejects false, missing or widened Vault KV gates', () => {
  const falseGate = fixture();
  falseGate.gates.sealedVaultFailsClosed = false;
  assert.equal(
    validateVaultKvWorkerSecretLiveReport(falseGate).compatible,
    false,
  );
  const widened = fixture();
  widened.gates.unreviewed = true;
  assert.equal(
    validateVaultKvWorkerSecretLiveReport(widened).compatible,
    false,
  );
  const missing = fixture();
  delete missing.gates.tokenRevalidatedPerResolution;
  assert.equal(
    validateVaultKvWorkerSecretLiveReport(missing).compatible,
    false,
  );
});

test('rejects sensitive material or widened report shape', () => {
  const sensitive = fixture();
  sensitive.limitations[0] =
    'vault-private-generation-one-must-never-enter-the-report';
  assert.match(
    validateVaultKvWorkerSecretLiveReport(sensitive).findings.join('; '),
    /sensitive material/,
  );
  const widened = fixture();
  widened.endpoint = 'https://vault.private:8200';
  const findings = validateVaultKvWorkerSecretLiveReport(widened).findings;
  assert.ok(findings.includes('report envelope is invalid'));
  assert.match(findings.join('; '), /endpoint is forbidden/);
});
