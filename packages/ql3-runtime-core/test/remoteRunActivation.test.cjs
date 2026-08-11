const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  assertAcknowledgeRemoteRunRunningCommand,
  assertAcknowledgeRemoteRunStartingCommand,
  assertFailRemoteRunStartCommand,
} = require('@qinglong/runtime-core/remote-activation');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const EVENT_A = '018f5c64-9b9d-7f1a-8c2d-1234567890a1';
const EVENT_B = '018f5c64-9b9d-7f1a-8c2d-1234567890a2';

function fence() {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
  };
}

test('validates starting, running and start-failure activation commands', () => {
  assert.doesNotThrow(() => assertAcknowledgeRemoteRunStartingCommand({
    ...fence(), eventId: EVENT_A,
  }));
  assert.doesNotThrow(() => assertAcknowledgeRemoteRunRunningCommand({
    ...fence(),
    attemptEventId: EVENT_A,
    runEventId: EVENT_B,
    executorHandle: 'remote:handle-1',
    logArtifactId: 'artifact-1',
    callbackSequence: 1,
    callbackTokenDigest: 'a'.repeat(64),
  }));
  assert.doesNotThrow(() => assertFailRemoteRunStartCommand({
    ...fence(), attemptEventId: EVENT_A, runEventId: EVENT_B,
  }));
});

test('rejects unbounded handles and malformed callback digests', () => {
  assert.throws(
    () => assertAcknowledgeRemoteRunRunningCommand({
      ...fence(),
      attemptEventId: EVENT_A,
      runEventId: EVENT_B,
      executorHandle: 'x'.repeat(513),
      callbackSequence: 1,
      callbackTokenDigest: 'a'.repeat(64),
    }),
    /executorHandle/,
  );
  assert.throws(
    () => assertAcknowledgeRemoteRunRunningCommand({
      ...fence(),
      attemptEventId: EVENT_A,
      runEventId: EVENT_B,
      executorHandle: 'remote:handle-1',
      callbackSequence: 1,
      callbackTokenDigest: 'A'.repeat(64),
    }),
    /callbackTokenDigest/,
  );
});
