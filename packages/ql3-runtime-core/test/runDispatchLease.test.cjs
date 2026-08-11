const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidRunDispatchLeaseValueError,
  assertRunDispatchLeaseRecord,
  digestRunDispatchLeaseToken,
} = require('../dist');

test('derives a one-way lease capability digest and validates its exact fence', () => {
  const token = 'lease_token_000000000000000000001';
  const digest = digestRunDispatchLeaseToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest.includes(token), false);
  assert.doesNotThrow(() =>
    assertRunDispatchLeaseRecord({
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'leased',
      version: 0,
      leaseGeneration: 1,
      workerId: 'worker-a',
      workerSessionId: '018f0000-0000-7000-8000-000000000001',
      workerGeneration: 1,
      leaseTokenDigest: digest,
      acquiredAtMs: 10,
      renewedAtMs: 10,
      expiresAtMs: 20,
      updatedAtMs: 10,
    }),
  );
});

test('rejects raw or malformed capability persistence and partial terminal shape', () => {
  assert.throws(
    () =>
      assertRunDispatchLeaseRecord({
        attemptId: 'attempt-1',
        runId: 'run-1',
        status: 'released',
        version: 1,
        leaseGeneration: 1,
        workerId: 'worker-a',
        workerSessionId: '018f0000-0000-7000-8000-000000000001',
        workerGeneration: 1,
        leaseTokenDigest: 'lease_token_000000000000000000001',
        acquiredAtMs: 10,
        renewedAtMs: 10,
        expiresAtMs: 20,
        releasedAtMs: 20,
        updatedAtMs: 20,
      }),
    InvalidRunDispatchLeaseValueError,
  );
});
