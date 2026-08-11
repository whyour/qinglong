const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputKeyRotationKubernetesLiveReport,
} = require('../../scripts/ql3-prompt-output-key-rotation-kubernetes-live-audit.cjs');

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
      generationBefore: 1,
      generationAfter: 2,
      keyCountAfter: 2,
      preparationCount: 1,
      completionCount: 1,
      contentFreeFacts: true,
      projectedTokenExpirationSeconds: 600,
      stagedFileMode: 0o440,
      stagedFileReadOnly: true,
      previousKeyRetained: true,
      newKeyActive: true,
      resourceVersionChangedOnce: true,
      secretIdentityBound: true,
      tokenAbsentFromInit: true,
      rbacExact: true,
      stagingApiDenied: true,
      denyCanaryControlReachable: true,
      denyCanaryEgressDenied: true,
      runtimeGenerationReloaded: true,
      runtimePodIdentityStable: true,
      runtimeCredentialAbsent: true,
      atomicWriterSymlink: true,
      historicalArtifactOpened: true,
      transientUnavailableObserved: false,
    },
    gates: {
      contentFreeEvidence: true,
      durableReplay: true,
      exactRbac: true,
      externallyStagedMaterial: true,
      historicalDecrypt: true,
      passed: true,
      realCloudNativePg: true,
      realKubernetesApi: true,
      resourceVersionCas: true,
      samePodNetworkBarrier: true,
      sameProcessRuntimeReload: true,
      shortLivedToken: true,
    },
    limitations: LIMITATIONS,
  };
}

test('accepts the exact content-free Kubernetes rotation report', () => {
  assert.deepEqual(
    validatePromptOutputKeyRotationKubernetesLiveReport(report()).findings,
    [],
  );
});

test('rejects widened, false or material-bearing rotation reports', () => {
  for (const candidate of [
    { ...report(), material: 'private' },
    { ...report(), gates: { ...report().gates, passed: false } },
    {
      ...report(),
      operation: { ...report().operation, completionCount: 2 },
    },
  ]) {
    assert.equal(
      validatePromptOutputKeyRotationKubernetesLiveReport(candidate)
        .compatible,
      false,
    );
  }
});
