const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputKeyRetirementKubernetesLiveReport,
} = require('../../scripts/ql3-prompt-output-key-retirement-kubernetes-live-audit.cjs');

function report() {
  return {
    fixture: FIXTURE,
    observedAt: '2026-08-03T00:00:00.000Z',
    platform: {
      distribution: 'k3s',
      kubernetesVersion: 'v1.34.3+k3s1',
      architecture: 'arm64',
      kubernetesImageId: `sha256:${'1'.repeat(64)}`,
      cniName: 'flannel',
      controlPlaneNodes: 1,
      workerNodes: 2,
    },
    database: {
      operator: 'cloudnative-pg',
      operatorVersion: '1.30.0',
      postgresVersionNumber: 180004,
      instances: 3,
      readyInstances: 3,
      migrationCount: 54,
      aiMigrationCount: 16,
      role: 'ql3_ai_maintenance',
      tlsVerified: true,
    },
    operation: {
      jobsRun: 2,
      status: 'completed',
      replayStatus: 'existing',
      generationAfter: 2,
      retirementCount: 1,
      preparationCount: 1,
      completionCount: 1,
      projectedTokenExpirationSeconds: 600,
      activeKeyRetained: true,
      inactiveKeyRemoved: true,
      resourceVersionChangedOnce: true,
      secretIdentityBound: true,
      tokenAbsentFromInit: true,
      rbacExact: true,
      denyCanaryControlReachable: true,
      denyCanaryEgressDenied: true,
    },
    gates: {
      contentFreeEvidence: true,
      durableReplay: true,
      exactRbac: true,
      passed: true,
      realCloudNativePg: true,
      realKubernetesApi: true,
      resourceVersionCas: true,
      samePodNetworkBarrier: true,
      shortLivedToken: true,
    },
    limitations: LIMITATIONS,
  };
}

test('accepts the exact content-free Kubernetes retirement report', () => {
  assert.deepEqual(
    validatePromptOutputKeyRetirementKubernetesLiveReport(report()).findings,
    [],
  );
});

test('rejects widened, false or secret-bearing retirement reports', () => {
  for (const candidate of [
    { ...report(), token: 'private' },
    { ...report(), gates: { ...report().gates, passed: false } },
    {
      ...report(),
      operation: { ...report().operation, completionCount: 2 },
    },
  ]) {
    assert.equal(
      validatePromptOutputKeyRetirementKubernetesLiveReport(candidate)
        .compatible,
      false,
    );
  }
});
