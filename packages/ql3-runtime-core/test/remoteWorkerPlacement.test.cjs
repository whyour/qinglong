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
    protocolVersion: '1.0.0',
    supportTier: 'tier1',
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

test('defaults to Tier 1 protocol v1 and requires explicit legacy placement', () => {
  const legacy = worker({
    architecture: 'arm/v6', executors: ['remote-worker'],
    protocolVersion: '1.0.0', supportTier: 'legacy-only',
  });
  assert.deepEqual(evaluateRemoteWorkerPlacement(legacy, {}, 500), {
    matches: false, score: 0, mismatches: ['support_tier'],
  });
  assert.deepEqual(evaluateRemoteWorkerPlacement(
    legacy, { required: { supportTiers: ['legacy-only'] } }, 500,
  ), { matches: true, score: 0, mismatches: [] });
  const incompatible = worker({
    architecture: 'arm64', executors: ['remote-worker'],
    protocolVersion: '2.0.0', supportTier: 'tier1',
  });
  assert.deepEqual(evaluateRemoteWorkerPlacement(incompatible, {}, 500), {
    matches: false, score: 0, mismatches: ['protocol_version'],
  });
});

test('rejects unversioned capabilities and unknown support policy', () => {
  assert.throws(() => canonicalRemoteWorkerCapabilities({
    architecture: 'arm64', executors: ['remote-worker'],
  }), /shape is invalid/);
  assert.throws(() => normalizeRemoteWorkerPlacement({
    required: { supportTiers: ['unsupported'] },
  }), /supportTier is unknown/);
  assert.throws(() => normalizeRemoteWorkerPlacement({
    required: { protocolVersionRange: 'not-a-range' },
  }), /protocolVersionRange is not semver/);
  assert.throws(() => canonicalRemoteWorkerCapabilities({
    architecture: 'arm/v7', executors: ['remote-worker'],
    protocolVersion: '1.0.0', supportTier: 'tier1',
  }), /does not belong to supportTier/);
});

test('keeps Worker architecture tiers aligned with the release identity', () => {
  const { REMOTE_WORKER_ARCHITECTURES_BY_SUPPORT_TIER } =
    require('../dist/remote-execution/remoteWorkerCompatibility');
  const release = require('../../../ql3-release.json');
  assert.deepEqual(REMOTE_WORKER_ARCHITECTURES_BY_SUPPORT_TIER, {
    tier1: release.architectureSupport.tier1,
    candidate: release.architectureSupport.candidates,
    experimental: release.architectureSupport.experimentalBlocked,
    'legacy-only': release.architectureSupport.legacyOnly,
  });
});
