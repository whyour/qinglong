const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  canonicalRemoteWorkerCapabilities,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  projectWorkerSessionObservation,
  summarizeWorkerSessionObservation,
} = require('@qinglong/runtime-core/worker-session-observation');

function worker(overrides = {}) {
  const canonical = canonicalRemoteWorkerCapabilities(
    overrides.capabilities ?? {
      architecture: 'arm64',
      executors: ['remote-worker'],
      protocolVersion: '1.0.0',
      supportTier: 'tier1',
      operatingSystem: 'linux',
      runtimes: [{ name: 'node', version: '24.18.0' }],
      labels: { private: 'must-not-project' },
      capacity: {
        cpuCores: 2,
        memoryBytes: 512 * 1024 * 1024,
        diskBytes: 4 * 1024 * 1024 * 1024,
        gpu: [{ vendor: 'example', model: 'must-not-project' }],
      },
      features: ['must-not-project'],
    },
  );
  return Object.freeze({
    workerId: 'worker-a',
    sessionId: '018f0f5d-7b6a-7a11-8f4d-2f7b4f477001',
    generation: 3,
    status: 'online',
    version: 9,
    capabilitiesJson: canonical.json,
    capabilitiesHash: canonical.hash,
    maxConcurrentRuns: 4,
    availableSlots: 2,
    registeredAtMs: 1_000,
    lastHeartbeatAtMs: 1_900,
    leaseExpiresAtMs: 3_000,
    updatedAtMs: 1_900,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== 'capabilities'),
    ),
  });
}

test('projects only bounded Worker compatibility, runtime and capacity facts', () => {
  const observation = projectWorkerSessionObservation(worker(), 2_000);
  assert.deepEqual(observation, {
    workerId: 'worker-a',
    sessionId: '018f0f5d-7b6a-7a11-8f4d-2f7b4f477001',
    generation: 3,
    sessionVersion: 9,
    lifecycle: 'online',
    compatibility: 'default_placement',
    architecture: 'arm64',
    supportTier: 'tier1',
    protocolVersion: '1.0.0',
    operatingSystem: 'linux',
    maxConcurrentRuns: 4,
    availableSlots: 2,
    registeredAtMs: 1_000,
    lastHeartbeatAtMs: 1_900,
    leaseExpiresAtMs: 3_000,
    updatedAtMs: 1_900,
    observedAtMs: 2_000,
    runtimes: [{ name: 'node', version: '24.18.0' }],
    declaredCapacity: {
      cpuCores: 2,
      memoryBytes: 512 * 1024 * 1024,
      diskBytes: 4 * 1024 * 1024 * 1024,
      gpuCount: 1,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(observation),
    /must-not-project|labels|features|model/,
  );
  const summary = summarizeWorkerSessionObservation(observation);
  assert.equal(Object.hasOwn(summary, 'runtimes'), false);
  assert.equal(Object.hasOwn(summary, 'declaredCapacity'), false);
});

test('distinguishes explicit Tier, incompatible protocol and lifecycle state', () => {
  const candidate = projectWorkerSessionObservation(
    worker({
      capabilities: {
        architecture: 's390x',
        executors: ['remote-worker'],
        protocolVersion: '1.0.0',
        supportTier: 'candidate',
      },
    }),
    2_000,
  );
  assert.equal(candidate.compatibility, 'explicit_placement_required');

  const incompatible = projectWorkerSessionObservation(
    worker({
      capabilities: {
        architecture: 'amd64',
        executors: ['remote-worker'],
        protocolVersion: '2.0.0',
        supportTier: 'tier1',
      },
    }),
    2_000,
  );
  assert.equal(incompatible.compatibility, 'protocol_incompatible');
  assert.equal(
    projectWorkerSessionObservation(worker(), 3_000).lifecycle,
    'lease_expired',
  );
  assert.equal(
    projectWorkerSessionObservation(
      worker({ status: 'draining', availableSlots: 0 }),
      2_000,
    ).lifecycle,
    'draining',
  );
  assert.equal(
    projectWorkerSessionObservation(
      worker({
        status: 'offline',
        availableSlots: 0,
        leaseExpiresAtMs: 1_900,
      }),
      2_000,
    ).lifecycle,
    'offline',
  );
});

test('rejects an observation clock before the durable Session head', () => {
  assert.throws(
    () => projectWorkerSessionObservation(worker(), 1_899),
    /observedAtMs is invalid/,
  );
});
