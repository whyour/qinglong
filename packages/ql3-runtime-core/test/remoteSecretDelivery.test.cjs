'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES,
  createRemoteWorkerSecretDeliveryRequestBody,
  createRemoteWorkerSecretDeliveryResponseBody,
  normalizeRemoteWorkerSecretDeliveryCommand,
  parseRemoteWorkerSecretDeliveryResponse,
} = require('../dist/remote-execution/remoteSecretDelivery');
const { createSecretRef } = require('../dist/secret/secretReference');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const DIGEST = 'a'.repeat(64);
const SECRET_REF = createSecretRef({ projectId: 'project-1', name: 'token' });

function command(overrides = {}) {
  return {
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    runId: 'run-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    executionDigest: DIGEST,
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
    secretRefs: [SECRET_REF],
    ...overrides,
  };
}

test('creates a versioned request without duplicating path-bound identity', () => {
  const body = createRemoteWorkerSecretDeliveryRequestBody(command());
  assert.equal(body.schema, 'qinglong/remote-secret-delivery@v1');
  assert.equal('workerId' in body, false);
  assert.equal('workerSessionId' in body, false);
  assert.deepEqual(body.secretRefs, [SECRET_REF]);
  assert.ok(Object.isFrozen(body));
});

test('parses only an exact authority and ordered Secret set', () => {
  const response = createRemoteWorkerSecretDeliveryResponseBody({
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    executionDigest: DIGEST,
    values: [{ secretRef: SECRET_REF, value: 'private-value' }],
  }, [SECRET_REF]);
  const parsed = parseRemoteWorkerSecretDeliveryResponse(
    JSON.stringify(response),
    {
      runId: 'run-1', attemptId: 'attempt-1', offerId: 'offer-1',
      executionDigest: DIGEST, secretRefs: [SECRET_REF],
    },
  );
  assert.deepEqual(parsed.values, [
    { secretRef: SECRET_REF, value: 'private-value' },
  ]);
  assert.throws(
    () => parseRemoteWorkerSecretDeliveryResponse(JSON.stringify(response), {
      runId: 'run-other', attemptId: 'attempt-1', offerId: 'offer-1',
      executionDigest: DIGEST, secretRefs: [SECRET_REF],
    }),
    /authority does not match/,
  );
});

test('rejects duplicate, cross-project and oversized delivery input', () => {
  assert.throws(
    () => normalizeRemoteWorkerSecretDeliveryCommand(command({
      secretRefs: [SECRET_REF, SECRET_REF],
    })),
    /secretRefs are invalid/,
  );
  const foreign = createSecretRef({ projectId: 'project-2', name: 'token' });
  assert.throws(
    () => normalizeRemoteWorkerSecretDeliveryCommand(command({
      secretRefs: [foreign],
    })),
    /project is invalid/,
  );
  assert.throws(
    () => parseRemoteWorkerSecretDeliveryResponse(
      Buffer.alloc(MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES + 1),
      {
        runId: 'run-1', attemptId: 'attempt-1', offerId: 'offer-1',
        executionDigest: DIGEST, secretRefs: [SECRET_REF],
      },
    ),
    /byte size/,
  );
  const refs = Array.from({ length: 5 }, (_, index) =>
    createSecretRef({ projectId: 'project-1', name: `item-${index}` }));
  assert.throws(
    () => createRemoteWorkerSecretDeliveryResponseBody({
      runId: 'run-1', attemptId: 'attempt-1', offerId: 'offer-1',
      executionDigest: DIGEST,
      values: refs.map((secretRef) => ({
        secretRef,
        value: 'x'.repeat(16 * 1024),
      })),
    }, refs),
    /byte budget/,
  );
});
