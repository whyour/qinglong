const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  canonicalRemoteWorkerCapabilities,
  evaluateRemoteWorkerPlacement,
  normalizeRemoteWorkerPlacement,
} = require('../dist/remote-execution/remoteWorkerPlacement');

function worker(capabilities) {
  const snapshot = canonicalRemoteWorkerCapabilities(capabilities);
  return {
    workerId: 'worker-arm64',
    sessionId: '01944c19-7c00-7000-8000-000000000001',
    generation: 1,
    status: 'online',
    version: 0,
    capabilitiesJson: snapshot.json,
    capabilitiesHash: snapshot.hash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: 100,
    lastHeartbeatAtMs: 200,
    leaseExpiresAtMs: 10_000,
    updatedAtMs: 200,
  };
}

test('uses pinned SemVer for remote runtime range admission', () => {
  const placement = normalizeRemoteWorkerPlacement({
    required: {
      architectures: ['arm64'],
      runtimes: [{ name: 'node', versionRange: '>=24.18.0 <25' }],
    },
  });
  const candidate = worker({
    architecture: 'arm64',
    executors: ['remote-worker'],
    runtimes: [{ name: 'node', version: '24.18.0' }],
  });

  assert.deepEqual(evaluateRemoteWorkerPlacement(candidate, placement, 500), {
    matches: true,
    score: 0,
    mismatches: [],
  });
  assert.throws(
    () =>
      normalizeRemoteWorkerPlacement({
        required: {
          runtimes: [{ name: 'node', versionRange: 'not-a-range' }],
        },
      }),
    /versionRange is not semver/,
  );
});
