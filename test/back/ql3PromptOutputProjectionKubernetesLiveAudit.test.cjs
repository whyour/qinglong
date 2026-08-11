const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputProjectionKubernetesLiveReport,
} = require('../../scripts/ql3-prompt-output-projection-kubernetes-live-audit.cjs');

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
    projection: {
      generationBefore: 1,
      generationAfter: 2,
      defaultMode: 288,
      activeChanged: true,
      atomicWriterSymlink: true,
      dataFileOnly: true,
      historicalArtifactOpened: true,
      podIdentityStable: true,
      readOnlyMount: true,
      revisionChanged: true,
      runtimeCredentialAbsent: true,
      transientUnavailableObserved: true,
    },
    gates: {
      contentFreeEvidence: true,
      historicalDecrypt: true,
      passed: true,
      readOnlyRuntime: true,
      realAtomicProjection: true,
      realKubernetesApi: true,
      rotationRecovered: true,
      sameProcessRotation: true,
    },
    limitations: LIMITATIONS,
  };
}

test('accepts exact content-free projected-keyring rotation evidence', () => {
  assert.deepEqual(
    validatePromptOutputProjectionKubernetesLiveReport(report()).findings,
    [],
  );
});

test('rejects false, widened or sensitive projected-keyring evidence', () => {
  for (const candidate of [
    { ...report(), key: 'private' },
    {
      ...report(),
      projection: { ...report().projection, readOnlyMount: false },
    },
    { ...report(), gates: { ...report().gates, passed: false } },
  ]) {
    assert.equal(
      validatePromptOutputProjectionKubernetesLiveReport(candidate).compatible,
      false,
    );
  }
});
