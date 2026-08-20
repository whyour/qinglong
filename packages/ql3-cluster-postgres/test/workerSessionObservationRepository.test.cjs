const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  canonicalRemoteWorkerCapabilities,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  PostgresWorkerSessionObservationRepository,
} = require('@qinglong/cluster-postgres/worker-credential-manager');

function row(index, overrides = {}) {
  const canonical = canonicalRemoteWorkerCapabilities(
    overrides.capabilities ?? {
      architecture: index % 2 === 0 ? 'arm64' : 's390x',
      executors: ['remote-worker'],
      protocolVersion: '1.0.0',
      supportTier: index % 2 === 0 ? 'tier1' : 'candidate',
      runtimes: [{ name: 'node', version: '24.18.0' }],
    },
  );
  return {
    observedAtMs: 2_000,
    workerId: `worker-${String(index).padStart(2, '0')}`,
    sessionId: `018f0f5d-7b6a-7a11-8f4d-${String(index + 1).padStart(
      12,
      '0',
    )}`,
    generation: 1,
    status: 'online',
    version: 2,
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
  };
}

test('inspects one exact Worker without exposing raw capability content', async () => {
  const queries = [];
  const repository = new PostgresWorkerSessionObservationRepository({
    async query(text, values) {
      queries.push({ text, values });
      return { rows: [row(0)], rowCount: 1 };
    },
  });
  const result = await repository.inspect('worker-00');
  assert.equal(result.observedAtMs, 2_000);
  assert.equal(result.worker.workerId, 'worker-00');
  assert.equal(result.worker.compatibility, 'default_placement');
  assert.deepEqual(result.worker.runtimes, [
    { name: 'node', version: '24.18.0' },
  ]);
  assert.equal(Object.hasOwn(result.worker, 'capabilitiesJson'), false);
  assert.deepEqual(queries[0].values, ['worker-00']);
  assert.match(queries[0].text, /LIMIT 2/);
});

test('returns a masked absent inspection and a fixed sixteen-item keyset page', async () => {
  let call = 0;
  const repository = new PostgresWorkerSessionObservationRepository({
    async query(_text, values) {
      call += 1;
      if (call === 1) {
        return {
          rows: [{ observedAtMs: 2_000, workerId: null }],
          rowCount: 1,
        };
      }
      assert.deepEqual(values, [null, 17]);
      return {
        rows: Array.from({ length: 17 }, (_, index) => row(index)),
        rowCount: 17,
      };
    },
  });
  assert.deepEqual(await repository.inspect('missing-worker'), {
    observedAtMs: 2_000,
    worker: null,
  });
  const page = await repository.list(null);
  assert.equal(page.workers.length, 16);
  assert.equal(page.nextCursor, 'worker-15');
  assert.equal(page.workers[1].compatibility, 'explicit_placement_required');
  assert.equal(Object.hasOwn(page.workers[0], 'runtimes'), false);
  assert.equal(Object.hasOwn(page.workers[0], 'declaredCapacity'), false);
});

test('fails closed on identity, ordering and database-clock drift', async () => {
  const identity = new PostgresWorkerSessionObservationRepository({
    async query() {
      return { rows: [row(1)], rowCount: 1 };
    },
  });
  await assert.rejects(identity.inspect('worker-00'), /identity drifted/);

  const unordered = new PostgresWorkerSessionObservationRepository({
    async query() {
      return { rows: [row(1), row(0)], rowCount: 2 };
    },
  });
  await assert.rejects(unordered.list(null), /page is unordered/);

  const clock = new PostgresWorkerSessionObservationRepository({
    async query() {
      return {
        rows: [row(0), row(1, { observedAtMs: 2_001 })],
        rowCount: 2,
      };
    },
  });
  await assert.rejects(clock.list(null), /clock drifted/);
});
