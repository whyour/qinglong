'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  REQUIRED_GATES,
  validatePluginPackageSecretBindingKubernetesLiveReport,
} = require('../../scripts/ql3-plugin-package-secret-binding-kubernetes-live-audit.cjs');

function report() {
  const digest = 'a'.repeat(64);
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAtMs: 1,
    platform: {
      architecture: 'arm64',
      kubernetesVersion: 'v1.34.3+k3s1',
      nodeCount: 3,
      postgresVersionNumber: 180004,
      adminImageId: `sha256:${digest}`,
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
    gates: Object.fromEntries(REQUIRED_GATES.map((gate) => [gate, true])),
    limitations: [
      'single-server k3s control plane is not Kubernetes control-plane HA evidence',
      'PostgreSQL physical failover is proven by the independent 125-gate HA contract',
    ],
  };
}

test('accepts one exact low-sensitive Secret binding Kubernetes report', () => {
  assert.deepEqual(
    validatePluginPackageSecretBindingKubernetesLiveReport(report()).findings,
    [],
  );
});

test('rejects false gates, topology drift and sensitive material', () => {
  const invalid = report();
  invalid.gates.realExecutorJob = false;
  invalid.management.distinctNodeHashes[1] =
    invalid.management.distinctNodeHashes[0];
  invalid.executor.secretRef = 'qlsecret:v1:forbidden';
  const findings =
    validatePluginPackageSecretBindingKubernetesLiveReport(invalid).findings;
  assert.ok(findings.some((value) => value.includes('management')));
  assert.ok(findings.some((value) => value.includes('gates')));
  assert.ok(findings.some((value) => value.includes('forbidden')));
});
