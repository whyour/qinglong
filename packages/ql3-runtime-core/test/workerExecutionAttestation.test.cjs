const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeSubmitWorkerExecutionAttestationCommand,
  normalizeWorkerExecutionAttestation,
} = require('@qinglong/runtime-core/worker-attestation');

function attestation(overrides = {}) {
  return {
    attestationId: '018f5c64-9b9d-7f1a-8c2d-1234567890ab',
    runId: 'run-1',
    attemptId: 'attempt-1',
    sequence: 1,
    state: 'running',
    workerId: 'edge-router-1',
    workerSessionId: '018f5c64-9b9d-7f1a-8c2d-1234567890ac',
    workerGeneration: 2,
    leaseTokenDigest: 'a'.repeat(64),
    leaseGeneration: 3,
    leaseVersion: 4,
    offerId: 'offer-1',
    callbackSequence: 5,
    executorHandle: 'remote:handle-1',
    journalRevision: 6,
    receivedAtMs: 7,
    ...overrides,
  };
}

test('normalizes an exact immutable Worker execution attestation', () => {
  const value = normalizeWorkerExecutionAttestation(attestation());
  assert.deepEqual(value, attestation());
  assert.equal(Object.isFrozen(value), true);
  const { receivedAtMs, ...command } = attestation();
  assert.deepEqual(
    normalizeSubmitWorkerExecutionAttestationCommand(command),
    command,
  );
  assert.equal(receivedAtMs, 7);
});

test('rejects widened, malformed and under-fenced attestations', () => {
  for (const value of [
    { ...attestation(), extra: true },
    attestation({ attestationId: 'not-v7' }),
    attestation({ sequence: 0 }),
    attestation({ state: 'unknown' }),
    attestation({ workerSessionId: 'not-v7' }),
    attestation({ workerGeneration: 0 }),
    attestation({ leaseTokenDigest: 'A'.repeat(64) }),
    attestation({ leaseGeneration: 0 }),
    attestation({ executorHandle: '' }),
    attestation({ journalRevision: 0 }),
  ]) {
    assert.throws(() => normalizeWorkerExecutionAttestation(value));
  }
});
