const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  InvalidWorkerSessionValueError,
  assertWorkerSessionRecord,
  assertWorkerCapabilitiesSnapshot,
} = require('../dist');

function capabilities() {
  const json = '{"architecture":"arm64","executors":["remote-worker"]}';
  return {
    json,
    hash: createHash('sha256').update(json).digest('hex'),
  };
}

test('validates one exact bounded Worker Session snapshot', () => {
  const snapshot = capabilities();
  assert.doesNotThrow(() =>
    assertWorkerSessionRecord({
      workerId: 'edge-router-1',
      sessionId: '018f0000-0000-7000-8000-000000000001',
      generation: 1,
      status: 'online',
      version: 0,
      capabilitiesJson: snapshot.json,
      capabilitiesHash: snapshot.hash,
      maxConcurrentRuns: 2,
      availableSlots: 1,
      registeredAtMs: 10,
      lastHeartbeatAtMs: 11,
      leaseExpiresAtMs: 20,
      updatedAtMs: 11,
    }),
  );
});

test('rejects forged capabilities, partial status capacity and invalid time', () => {
  const snapshot = capabilities();
  assert.throws(
    () => assertWorkerCapabilitiesSnapshot(snapshot.json, '0'.repeat(64)),
    InvalidWorkerSessionValueError,
  );
  assert.throws(
    () =>
      assertWorkerSessionRecord({
        workerId: 'edge-router-1',
        sessionId: '018f0000-0000-7000-8000-000000000001',
        generation: 1,
        status: 'draining',
        version: 0,
        capabilitiesJson: snapshot.json,
        capabilitiesHash: snapshot.hash,
        maxConcurrentRuns: 1,
        availableSlots: 1,
        registeredAtMs: 10,
        lastHeartbeatAtMs: 11,
        leaseExpiresAtMs: 20,
        updatedAtMs: 11,
      }),
    InvalidWorkerSessionValueError,
  );
});
