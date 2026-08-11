const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  canonicalRemoteWorkerCapabilities,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core');
const {
  ClusterRemoteWorkerOfferClaimService,
  ClusterRemoteWorkerOfferFenceRejectedError,
} = require('../dist/remote-execution/remoteWorkerDispatcher');

const SESSION = '018f0000-0000-7000-8000-000000000001';
const TOKEN = 'worker_generated_lease_capability_0000000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;

function candidate() {
  return {
    runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
    taskId: 'task-1', taskRevision: TASK_REVISION, priority: 2,
    queuedAtMs: 10, attemptCreatedAtMs: 11, attemptNumber: 1,
    executorType: 'remote_worker',
  };
}

function revision() {
  return createClusterTaskExecutionRevision({
    projectId: 'project-1', taskId: 'task-1', taskRevision: TASK_REVISION,
    sourceRevision: 1, sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker', planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/usr/bin/node', args: ['job.js'] },
    environment: [],
    placement: { required: { architectures: ['arm64'] } },
    createdAtMs: 1,
  });
}

function worker() {
  const capabilities = canonicalRemoteWorkerCapabilities({
    architecture: 'arm64', executors: ['remote-worker'],
  });
  return {
    workerId: 'edge-1', sessionId: SESSION, generation: 2,
    status: 'online', version: 1,
    capabilitiesJson: capabilities.json, capabilitiesHash: capabilities.hash,
    maxConcurrentRuns: 1, availableSlots: 1,
    registeredAtMs: 1, lastHeartbeatAtMs: 10,
    leaseExpiresAtMs: 60_000, updatedAtMs: 10,
  };
}

function lease() {
  return {
    attemptId: 'attempt-1', runId: 'run-1', status: 'leased', version: 0,
    leaseGeneration: 1, workerId: 'edge-1', workerSessionId: SESSION,
    workerGeneration: 2, leaseTokenDigest: digestRunDispatchLeaseToken(TOKEN),
    acquiredAtMs: 1000, renewedAtMs: 1000, expiresAtMs: 31_000,
    updatedAtMs: 1000,
  };
}

function service(overrides = {}) {
  const calls = [];
  const source = overrides.source ?? {
    async findClusterDispatchRecovery() { return null; },
    async listClusterDispatchCandidates() {
      calls.push('candidates');
      return { observedAtMs: 1000, candidates: [candidate()], truncated: false };
    },
  };
  const value = new ClusterRemoteWorkerOfferClaimService(
    source,
    overrides.workers ?? { async findById() { calls.push('worker'); return worker(); } },
    overrides.revisions ?? {
      async resolveClusterTaskExecutionRevision() { calls.push('revision'); return revision(); },
    },
    overrides.leases ?? {
      async claim(command) { calls.push(`claim:${command.offerId}`); return { status: 'claimed', lease: lease() }; },
    },
    { createEventId: () => 'event-1' },
  );
  return { value, calls };
}

const command = {
  workerSessionId: SESSION,
  workerGeneration: 2,
  offerId: 'offer-1',
  leaseToken: TOKEN,
};

test('pulls one bounded candidate, applies Placement and atomically returns a fenced offer', async () => {
  const { value, calls } = service();
  const result = await value.claimNext({ workerId: 'edge-1' }, command);
  assert.equal(result.status, 'offered');
  assert.equal(result.offer.deliveryKind, 'new_claim');
  assert.equal(result.offer.worker.sessionId, SESSION);
  assert.equal(result.offer.executionRevision.placement.required.executors[0], 'remote-worker');
  assert.deepEqual(calls, ['candidates', 'worker', 'revision', 'claim:offer-1']);
});

test('rebuilds a lost response only for the same Worker-provided offer capability', async () => {
  const { value } = service({
    source: {
      async findClusterDispatchRecovery() {
        return {
          observedAtMs: 2000,
          candidate: candidate(),
          lease: lease(),
          workerCurrent: true,
        };
      },
      async listClusterDispatchCandidates() { throw new Error('must not list'); },
    },
  });
  const result = await value.claimNext({ workerId: 'edge-1' }, command);
  assert.equal(result.status, 'offered');
  assert.equal(result.offer.deliveryKind, 'lease_recovery');
  await assert.rejects(
    value.claimNext({ workerId: 'edge-1' }, { ...command, leaseToken: `${TOKEN}x` }),
    ClusterRemoteWorkerOfferFenceRejectedError,
  );
});

test('returns low-cardinality idle evidence when the authenticated Worker does not match', async () => {
  const { value } = service({
    workers: { async findById() { return { ...worker(), sessionId: '018f0000-0000-7000-8000-000000000002' }; } },
  });
  const result = await value.claimNext({ workerId: 'edge-1' }, command);
  assert.deepEqual(
    { status: result.status, reason: result.reason },
    { status: 'idle', reason: 'worker_unavailable' },
  );
});
