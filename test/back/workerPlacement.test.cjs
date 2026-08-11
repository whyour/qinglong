require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  matchesWorkerPlacement,
  normalizeWorkerPlacementSpec,
  selectWorkerCandidates,
} = require('../../back/runtime/domain/workerPlacement');

const NOW = 10_000;

function worker(id, overrides = {}) {
  return {
    id,
    sessionId: '019f7700-0000-7000-8000-000000000001',
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['local_process'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: { region: 'cn-east', storage: 'ssd' },
      capacity: {
        cpuCores: 4,
        memoryBytes: 8 * 1024 * 1024 * 1024,
        diskBytes: 100 * 1024 * 1024 * 1024,
        gpu: [{ vendor: 'nvidia', model: 'T4', memoryBytes: 16_000_000_000 }],
      },
      features: ['direct_file_log'],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 4,
    availableSlots: 2,
    registeredAtMs: 1,
    lastHeartbeatAtMs: 9_000,
    leaseExpiresAtMs: 20_000,
    updatedAtMs: 9_000,
    ...overrides,
  };
}

test('matches every required capability including semantic runtime ranges', () => {
  const placement = {
    required: {
      architectures: ['arm64'],
      operatingSystems: ['linux'],
      executors: ['local_process'],
      runtimes: [{ name: 'node', versionRange: '>=24 <25' }],
      labels: { storage: 'ssd' },
      minMemoryBytes: 4 * 1024 * 1024 * 1024,
      minDiskBytes: 50 * 1024 * 1024 * 1024,
      gpuVendor: 'nvidia',
      features: ['direct_file_log'],
    },
  };
  assert.deepEqual(matchesWorkerPlacement(worker('worker-a'), placement, NOW), {
    matches: true,
    score: 0,
    mismatches: [],
  });

  const mismatch = matchesWorkerPlacement(
    worker('worker-b', {
      capabilities: {
        ...worker('worker-b').capabilities,
        architecture: 'x64',
        executors: [],
        runtimes: [{ name: 'node', version: '22.14.0' }],
        labels: {},
        capacity: {},
        features: [],
      },
    }),
    placement,
    NOW,
  );
  assert.equal(mismatch.matches, false);
  assert.deepEqual(mismatch.mismatches, [
    'architecture',
    'executor',
    'runtime',
    'label',
    'memory',
    'disk',
    'gpu',
    'feature',
  ]);
});

test('excludes unavailable Workers and ranks preferences deterministically', () => {
  const placement = {
    required: { architectures: ['arm64'] },
    preferred: [
      { labels: { region: 'cn-east' }, weight: 50 },
      { labels: { storage: 'ssd' }, weight: 20 },
    ],
  };
  const selected = selectWorkerCandidates(
    [
      worker('worker-c', {
        capabilities: {
          ...worker('worker-c').capabilities,
          labels: { region: 'cn-west', storage: 'ssd' },
        },
        availableSlots: 4,
      }),
      worker('worker-b', { availableSlots: 3 }),
      worker('worker-a', { availableSlots: 1 }),
      worker('worker-expired', { leaseExpiresAtMs: NOW }),
      worker('worker-draining', { status: 'draining', availableSlots: 0 }),
    ],
    placement,
    NOW,
  );
  assert.deepEqual(
    selected.map((candidate) => [candidate.worker.id, candidate.score]),
    [
      ['worker-b', 70],
      ['worker-a', 70],
      ['worker-c', 20],
    ],
  );
});

test('rejects ambiguous or unbounded placement input', () => {
  assert.throws(
    () =>
      normalizeWorkerPlacementSpec({
        required: { runtimes: [{ name: 'node', versionRange: 'not a range' }] },
      }),
    /not semver/,
  );
  assert.throws(
    () => normalizeWorkerPlacementSpec({ required: { command: 'secret' } }),
    /unknown field/,
  );
  assert.throws(
    () =>
      selectWorkerCandidates(
        Array.from({ length: 65 }, (_, index) => worker(`worker-${index}`)),
        {},
        NOW,
      ),
    /at most 64/,
  );
});

test('normalizes one placement snapshot for a bounded candidate page', () => {
  const placement = {
    required: { architectures: ['arm64'] },
  };
  const normalized = normalizeWorkerPlacementSpec(placement);
  assert.deepEqual(
    selectWorkerCandidates(
      [worker('worker-b'), worker('worker-a')],
      normalized,
      NOW,
    ).map(({ worker: candidate }) => candidate.id),
    ['worker-a', 'worker-b'],
  );
});
