'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LEGACY_FIXTURE,
  LEGACY_REQUIRED_GATES,
  REQUIRED_GATES,
  validatePluginPackageSecretBindingKubernetesLiveReport,
} = require('../../scripts/ql3-plugin-package-secret-binding-kubernetes-live-audit.cjs');

function report() {
  const digest = 'a'.repeat(64);
  return {
    schemaVersion: 2,
    fixture: FIXTURE,
    observedAtMs: 1,
    platform: {
      architecture: 'arm64',
      kubernetesVersion: 'v1.34.3+k3s1',
      nodeCount: 3,
      postgresVersionNumber: 180004,
      adminImageId: `sha256:${digest}`,
      controlImageId: `sha256:${'9'.repeat(64)}`,
    },
    management: {
      replicas: 2,
      distinctNodeHashes: [
        `sha256:${'1'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
      ],
      serviceAccountTokenMounted: false,
      packageValueVolumeMounted: false,
      canGetSecrets: false,
      canListSecrets: false,
    },
    review: {
      commands: [
        'plugin-package.secret-binding.plan',
        'plugin-package.secret-binding.plan',
        'plugin-package.secret-binding.propose',
        'plugin-package.secret-binding.decide',
        'plugin-package.secret-binding.inspect',
      ],
      requesterSubjectHash: `sha256:${'3'.repeat(64)}`,
      reviewerSubjectHash: `sha256:${'4'.repeat(64)}`,
      distinctUsers: true,
      planStatus: 'created',
      replayStatus: 'existing',
      decisionStatus: 'decided',
      inspectionStale: false,
      actionDigest: '5'.repeat(64),
      planDigest: '6'.repeat(64),
    },
    executor: {
      jobSucceeded: true,
      serviceAccountTokenMounted: false,
      canGetSecrets: false,
      canListSecrets: false,
      projectionReadOnly: true,
      projectionFileCount: 1,
      projectionKeyHash: `sha256:${'7'.repeat(64)}`,
      outputSensitiveFree: true,
    },
    persistence: {
      bindingCount: 1,
      authorityKind: 'approved-action-execution',
      evidenceDigest: '8'.repeat(64),
      entryCount: 1,
      approvalConsumed: true,
      executionSucceeded: true,
      sensitiveMatchCount: 0,
    },
    provider: {
      provider: 'mounted-files',
      replicas: 2,
      distinctNodeHashes: [
        `sha256:${'a'.repeat(64)}`,
        `sha256:${'b'.repeat(64)}`,
      ],
      serviceAccountTokenMounted: false,
      canGetSecrets: false,
      canListSecrets: false,
      canPatchSecrets: false,
      projectionReadOnly: true,
      projectionMode: '0440',
      firstGenerationObserved: 2,
      rotatedGenerationObserved: 2,
      resourceVersionAdvanced: true,
      outputSensitiveFree: true,
      missingProjectionRejected: true,
      missingErrorCode: 'QL3_CLUSTER_MOUNTED_SECRET_UNAVAILABLE',
    },
    gates: Object.fromEntries(REQUIRED_GATES.map((gate) => [gate, true])),
    limitations: [
      'single-server k3s control plane is not Kubernetes control-plane HA evidence',
      'PostgreSQL physical failover is proven by the independent 125-gate HA contract',
      'the mounted-files gate proves Kubernetes projection, not a direct Vault KMS or HSM adapter',
    ],
  };
}

function legacyReport() {
  const value = report();
  value.schemaVersion = 1;
  value.fixture = LEGACY_FIXTURE;
  delete value.platform.controlImageId;
  delete value.provider;
  value.gates = Object.fromEntries(
    LEGACY_REQUIRED_GATES.map((gate) => [gate, true]),
  );
  value.limitations = value.limitations.slice(0, 2);
  return value;
}

test('accepts one exact low-sensitive Secret binding Kubernetes report', () => {
  assert.deepEqual(
    validatePluginPackageSecretBindingKubernetesLiveReport(report()).findings,
    [],
  );
});

test('continues to verify the immutable v1 report shape', () => {
  assert.deepEqual(
    validatePluginPackageSecretBindingKubernetesLiveReport(legacyReport())
      .findings,
    [],
  );
});

test('rejects false gates, topology drift and sensitive material', () => {
  const invalid = report();
  invalid.gates.realExecutorJob = false;
  invalid.management.distinctNodeHashes[1] =
    invalid.management.distinctNodeHashes[0];
  invalid.provider.missingProjectionRejected = false;
  invalid.executor.secretRef = 'qlsecret:v1:forbidden';
  const findings =
    validatePluginPackageSecretBindingKubernetesLiveReport(invalid).findings;
  assert.ok(findings.some((value) => value.includes('management')));
  assert.ok(findings.some((value) => value.includes('gates')));
  assert.ok(findings.some((value) => value.includes('provider')));
  assert.ok(findings.some((value) => value.includes('forbidden')));
});
