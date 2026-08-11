'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RemoteWorkerSecretDeliveryFenceRejectedError,
} = require('@qinglong/runtime-core/remote-secret-delivery');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  ClusterRemoteWorkerSecretDeliveryService,
} = require('../dist/remote-execution/remoteWorkerSecretDeliveryService');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const SECRET_REF = createSecretRef({ projectId: 'project-1', name: 'token' });
const DIGEST = 'a'.repeat(64);

function command() {
  return {
    workerSessionId: SESSION_ID, workerGeneration: 2,
    runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
    taskId: 'task-1', taskRevision: 'revision-1', executionDigest: DIGEST,
    offerId: 'offer-1', leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4, secretRefs: [SECRET_REF],
  };
}

function authority(input) {
  const { leaseToken: _leaseToken, expectedLeaseVersion, ...rest } = input;
  return {
    workerId: 'edge-1', ...rest, leaseVersion: expectedLeaseVersion,
  };
}

test('resolves plaintext only after repository authority succeeds', async () => {
  const events = [];
  let authorized;
  const service = new ClusterRemoteWorkerSecretDeliveryService({
    async authorize(input) {
      events.push('authorize');
      authorized = input;
      return authority(input);
    },
  }, {
    async resolve(input) {
      events.push('resolve');
      assert.equal('leaseToken' in input, false);
      return {
        values: [{ secretRef: SECRET_REF, value: 'resolved-value' }],
        dispose() { events.push('dispose'); },
      };
    },
  });
  const result = await service.deliver({ workerId: 'edge-1' }, command());
  assert.equal(authorized.workerId, 'edge-1');
  assert.deepEqual(result.values, [
    { secretRef: SECRET_REF, value: 'resolved-value' },
  ]);
  assert.deepEqual(events, ['authorize', 'resolve']);
  await result.dispose();
  assert.deepEqual(events, ['authorize', 'resolve', 'dispose']);
});

test('never calls the plaintext provider for fenced or replayed authority', async () => {
  let resolutions = 0;
  const service = new ClusterRemoteWorkerSecretDeliveryService({
    async authorize() {
      throw new RemoteWorkerSecretDeliveryFenceRejectedError('authority_mismatch');
    },
  }, {
    async resolve() { resolutions += 1; },
  });
  await assert.rejects(
    service.deliver({ workerId: 'edge-1' }, command()),
    /authority_mismatch/,
  );
  assert.equal(resolutions, 0);
});

test('never calls plaintext provider when an injected repository widens authority', async () => {
  let resolutions = 0;
  const service = new ClusterRemoteWorkerSecretDeliveryService({
    async authorize(input) {
      return { ...authority(input), taskId: 'task-other' };
    },
  }, {
    async resolve() { resolutions += 1; },
  });
  await assert.rejects(
    service.deliver({ workerId: 'edge-1' }, command()),
    /unavailable/,
  );
  assert.equal(resolutions, 0);
});

test('disposes malformed provider output and converts it to unavailable', async () => {
  let disposed = 0;
  const service = new ClusterRemoteWorkerSecretDeliveryService({
    async authorize(input) { return authority(input); },
  }, {
    async resolve() {
      return {
        values: [{ secretRef: SECRET_REF, value: 'x'.repeat(17 * 1024) }],
        dispose() { disposed += 1; },
      };
    },
  });
  await assert.rejects(
    service.deliver({ workerId: 'edge-1' }, command()),
    /unavailable/,
  );
  assert.equal(disposed, 1);
});

test('rejects extensible provider output and still invokes valid cleanup', async () => {
  let disposed = 0;
  const service = new ClusterRemoteWorkerSecretDeliveryService({
    async authorize(input) { return authority(input); },
  }, {
    async resolve() {
      return {
        values: [{ secretRef: SECRET_REF, value: 'resolved-value' }],
        dispose() { disposed += 1; },
        diagnostic: 'must-not-cross-boundary',
      };
    },
  });
  await assert.rejects(
    service.deliver({ workerId: 'edge-1' }, command()),
    /unavailable/,
  );
  assert.equal(disposed, 1);
});
