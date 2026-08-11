'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  createClusterRemoteExecutionOffer,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core/run-dispatch-lease');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  WorkerRemoteSecretHttpsProvider,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const SECRET_REF = createSecretRef({ projectId: 'project-1', name: 'token' });

function acceptedOffer() {
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1', taskId: 'task-1', taskRevision: TASK_REVISION,
    sourceRevision: 1, sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker', planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [{ name: 'TOKEN', kind: 'secret', secretRef: SECRET_REF }],
    createdAtMs: 1,
  });
  return createClusterRemoteExecutionOffer({
    offerId: 'offer-1', deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate: {
      runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
      taskId: 'task-1', taskRevision: TASK_REVISION, priority: 1,
      queuedAtMs: 10, attemptCreatedAtMs: 11, attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: { workerId: 'edge-1', sessionId: SESSION_ID, generation: 2 },
    lease: {
      attemptId: 'attempt-1', runId: 'run-1', status: 'leased', version: 4,
      leaseGeneration: 3, workerId: 'edge-1', workerSessionId: SESSION_ID,
      workerGeneration: 2, leaseTokenDigest: digestRunDispatchLeaseToken(LEASE_TOKEN),
      acquiredAtMs: 20, renewedAtMs: 20, expiresAtMs: 30_020,
      updatedAtMs: 20,
    },
    leaseToken: LEASE_TOKEN, executionRevision, placementScore: 0,
  });
}

function requestFor(offer) {
  return {
    projectId: offer.candidate.projectId,
    taskId: offer.candidate.taskId,
    taskRevision: offer.candidate.taskRevision,
    runId: offer.candidate.runId,
    attemptId: offer.candidate.attemptId,
    offerId: offer.offerId,
    executionDigest: offer.executionDigest,
    secretRefs: [SECRET_REF],
  };
}

test('rehydrates lease authority from inbox and delivers one exact Secret batch', async () => {
  const offer = acceptedOffer();
  let transport;
  const provider = new WorkerRemoteSecretHttpsProvider({
    inbox: {
      async readOffer(offerId) {
        assert.equal(offerId, offer.offerId);
        return { state: 'starting_acknowledged', offer };
      },
    },
    client: {
      async postJson(request) {
        transport = request;
        return Buffer.from(JSON.stringify({
          schema: 'qinglong/remote-secret-delivery@v1',
          runId: 'run-1', attemptId: 'attempt-1', offerId: 'offer-1',
          executionDigest: offer.executionDigest,
          values: [{ secretRef: SECRET_REF, value: 'resolved-value' }],
        }));
      },
    },
  });
  const resolution = await provider.resolve(requestFor(offer));
  assert.deepEqual(resolution.values, [
    { secretRef: SECRET_REF, value: 'resolved-value' },
  ]);
  assert.equal(transport.path.endsWith(`/sessions/${SESSION_ID}/secrets`), true);
  assert.equal(transport.body.leaseToken, LEASE_TOKEN);
  assert.equal(transport.maximumRequestBytes, 64 * 1024);
  assert.equal(JSON.stringify(requestFor(offer)).includes(LEASE_TOKEN), false);
});

test('rejects a stale inbox identity before sending the capability', async () => {
  const offer = acceptedOffer();
  let calls = 0;
  const provider = new WorkerRemoteSecretHttpsProvider({
    inbox: {
      async readOffer() { return { state: 'starting_acknowledged', offer }; },
    },
    client: { async postJson() { calls += 1; } },
  });
  await assert.rejects(
    provider.resolve({ ...requestFor(offer), executionDigest: 'b'.repeat(64) }),
    /authority_mismatch/,
  );
  assert.equal(calls, 0);
});

test('rejects response authority drift and does not return plaintext', async () => {
  const offer = acceptedOffer();
  const provider = new WorkerRemoteSecretHttpsProvider({
    inbox: {
      async readOffer() { return { state: 'starting_acknowledged', offer }; },
    },
    client: {
      async postJson() {
        return Buffer.from(JSON.stringify({
          schema: 'qinglong/remote-secret-delivery@v1',
          runId: 'run-other', attemptId: 'attempt-1', offerId: 'offer-1',
          executionDigest: offer.executionDigest,
          values: [{ secretRef: SECRET_REF, value: 'must-not-escape' }],
        }));
      },
    },
  });
  await assert.rejects(provider.resolve(requestFor(offer)), /response_invalid/);
});

test('does not fetch Secrets before starting ACK or after the launch barrier', async () => {
  const offer = acceptedOffer();
  for (const state of ['accepted', 'launching']) {
    let calls = 0;
    const provider = new WorkerRemoteSecretHttpsProvider({
      inbox: { async readOffer() { return { state, offer }; } },
      client: { async postJson() { calls += 1; } },
    });
    await assert.rejects(provider.resolve(requestFor(offer)), /offer_unavailable/);
    assert.equal(calls, 0);
  }
});
