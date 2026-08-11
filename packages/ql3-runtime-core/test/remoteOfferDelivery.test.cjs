const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createClusterTaskExecutionRevision,
} = require('../dist/task-definition/clusterExecutionRevision');
const {
  createClusterRemoteExecutionOffer,
} = require('../dist/remote-execution/remoteDispatch');
const {
  digestRunDispatchLeaseToken,
} = require('../dist/run/runDispatchLease');
const {
  MAX_REMOTE_EXECUTION_OFFER_RESPONSE_BYTES,
  REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA,
  createRemoteExecutionOfferPullBody,
  parseRemoteExecutionOfferPullResponse,
} = require('../dist/remote-execution/remoteOfferDelivery');

const SESSION = '018f0000-0000-7000-8000-000000000001';
const TOKEN = 'worker_generated_lease_capability_0000000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;

function authority() {
  return {
    workerId: 'edge-1',
    workerSessionId: SESSION,
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseToken: TOKEN,
  };
}

function offer() {
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    sourceRevision: 1,
    sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/usr/bin/node', args: ['job.js'] },
    environment: [],
    createdAtMs: 1,
  });
  return createClusterRemoteExecutionOffer({
    offerId: 'offer-1',
    deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevision: TASK_REVISION,
      priority: 1,
      queuedAtMs: 10,
      attemptCreatedAtMs: 11,
      attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: { workerId: 'edge-1', sessionId: SESSION, generation: 2 },
    lease: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'leased',
      version: 3,
      leaseGeneration: 1,
      workerId: 'edge-1',
      workerSessionId: SESSION,
      workerGeneration: 2,
      leaseTokenDigest: digestRunDispatchLeaseToken(TOKEN),
      acquiredAtMs: 20,
      renewedAtMs: 21,
      expiresAtMs: 30_021,
      updatedAtMs: 21,
    },
    leaseToken: TOKEN,
    executionRevision,
    placementScore: 0,
  });
}

const stats = Object.freeze({
  pages: 1,
  candidates: 1,
  plansUnavailable: 0,
  placementMismatches: 0,
  claimAttempts: 1,
  claimRaces: 0,
});

test('round-trips an authenticated offer without serializing the lease capability', () => {
  const body = createRemoteExecutionOfferPullBody({
    status: 'offered',
    offer: offer(),
    stats,
    truncated: false,
  });
  const serialized = JSON.stringify(body);
  assert.equal(body.schema, REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(digestRunDispatchLeaseToken(TOKEN)), false);

  const parsed = parseRemoteExecutionOfferPullResponse(serialized, authority());
  assert.equal(parsed.status, 'offered');
  assert.equal(parsed.offer.leaseToken, TOKEN);
  assert.equal(parsed.offer.lease.version, 3);
  assert.equal(parsed.offer.executionDigest, offer().executionDigest);
});

test('rejects target drift, unknown fields and oversized responses', () => {
  const body = createRemoteExecutionOfferPullBody({
    status: 'offered',
    offer: offer(),
    stats,
    truncated: false,
  });
  assert.throws(
    () => parseRemoteExecutionOfferPullResponse(
      JSON.stringify({ ...body, unexpected: true }),
      authority(),
    ),
    /shape is invalid/,
  );
  assert.throws(
    () => parseRemoteExecutionOfferPullResponse(
      JSON.stringify({
        ...body,
        offer: {
          ...body.offer,
          worker: { ...body.offer.worker, generation: 3 },
        },
      }),
      authority(),
    ),
    /Worker target does not match claim/,
  );
  assert.throws(
    () => parseRemoteExecutionOfferPullResponse(
      Buffer.alloc(MAX_REMOTE_EXECUTION_OFFER_RESPONSE_BYTES + 1),
      authority(),
    ),
    /byte size/,
  );
});

test('validates bounded idle responses with the same versioned schema', () => {
  const body = createRemoteExecutionOfferPullBody({
    status: 'idle',
    reason: 'no_candidates',
    stats: { ...stats, candidates: 0, claimAttempts: 0 },
    truncated: false,
  });
  assert.deepEqual(
    parseRemoteExecutionOfferPullResponse(JSON.stringify(body), authority()),
    {
      status: 'idle',
      reason: 'no_candidates',
      stats: { ...stats, candidates: 0, claimAttempts: 0 },
      truncated: false,
    },
  );
});
