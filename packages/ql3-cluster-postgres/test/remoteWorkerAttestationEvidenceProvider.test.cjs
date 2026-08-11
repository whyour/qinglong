const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresRemoteWorkerAttestationEvidenceProvider,
} = require('../dist');

function target() {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    executorType: 'remote-worker',
    executorHandle: 'remote:handle-1',
    callbackSequence: 5,
    workerId: 'edge-1',
    workerSessionId: '018f5c64-9b9d-7f1a-8c2d-1234567890ac',
    workerGeneration: 2,
    leaseTokenDigest: 'a'.repeat(64),
    leaseGeneration: 3,
    leaseVersion: 4,
    offerId: 'offer-1',
  };
}

function attestation(state, receivedAtMs = 9_000) {
  return {
    attestationId: '018f5c64-9b9d-7f1a-8c2d-1234567890ab',
    ...target(),
    sequence: 1,
    state,
    journalRevision: 6,
    receivedAtMs,
  };
}

function provider(value, observedAtMs = '10000') {
  return new PostgresRemoteWorkerAttestationEvidenceProvider(
    { async query() { return { rows: [{ observedAtMs }] }; } },
    {
      async findLatestExact(observed) {
        assert.deepEqual(observed, {
          runId: 'run-1', attemptId: 'attempt-1', workerId: 'edge-1',
          workerSessionId: target().workerSessionId, workerGeneration: 2,
          leaseTokenDigest: 'a'.repeat(64), leaseGeneration: 3,
          leaseVersion: 4, offerId: 'offer-1', callbackSequence: 5,
          executorHandle: 'remote:handle-1',
        });
        return value;
      },
      async submit() { throw new Error('not used'); },
    },
    { runningFreshnessMs: 2_000 },
  );
}

test('treats only exact stopped attestation as authoritative not-running', async () => {
  const context = { signal: new AbortController().signal };
  assert.deepEqual(await provider(attestation('stopped')).inspect(target(), context), {
    status: 'not_running',
  });
  assert.deepEqual(await provider(attestation('running')).inspect(target(), context), {
    status: 'running',
  });
});

test('keeps missing, stale, malformed-time and cancelled evidence fail-closed', async () => {
  const context = { signal: new AbortController().signal };
  for (const candidate of [
    provider(null),
    provider(attestation('running', 1_000)),
    provider(attestation('running'), 'corrupt'),
  ]) {
    assert.deepEqual(await candidate.inspect(target(), context), {
      status: 'unknown',
      reason: 'provider_unavailable',
    });
  }
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await provider(attestation('running')).inspect(target(), {
    signal: controller.signal,
  }), { status: 'unknown', reason: 'provider_unavailable' });
});

test('rejects an unbounded attestation freshness window', () => {
  assert.throws(
    () => new PostgresRemoteWorkerAttestationEvidenceProvider(
      { async query() { return { rows: [] }; } },
      { async findLatestExact() { return null; }, async submit() {} },
      { runningFreshnessMs: 300_001 },
    ),
    /freshness is invalid/,
  );
});
