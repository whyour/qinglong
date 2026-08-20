const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  canonicalRemoteWorkerCapabilities,
  createClusterRemoteExecutionOffer,
  effectiveRemoteWorkerPlacement,
  evaluateRemoteWorkerPlacement,
} = require('../dist/remote-execution/remoteDispatch');
const {
  createClusterTaskExecutionRevision,
} = require('../dist/task-definition/clusterExecutionRevision');
const { digestRunDispatchLeaseToken } = require('../dist/run/runDispatchLease');

const SESSION = '018f0000-0000-7000-8000-000000000001';
const TOKEN = 'worker_generated_lease_capability_0000000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;

function worker() {
  const snapshot = canonicalRemoteWorkerCapabilities({
    architecture: 'arm64',
    executors: ['remote-worker'],
    protocolVersion: '1.0.0',
    supportTier: 'tier1',
    operatingSystem: 'linux',
    runtimes: [{ name: 'node', version: '24.18.0' }],
    labels: { region: 'cn-east', tier: 'edge' },
    capacity: { memoryBytes: 512 * 1024 * 1024 },
    features: ['artifact-v1'],
  });
  return {
    workerId: 'edge-1',
    sessionId: SESSION,
    generation: 2,
    status: 'online',
    version: 3,
    capabilitiesJson: snapshot.json,
    capabilitiesHash: snapshot.hash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: 1,
    lastHeartbeatAtMs: 10,
    leaseExpiresAtMs: 60_000,
    updatedAtMs: 10,
  };
}

function revision() {
  return createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    sourceRevision: 1,
    sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/usr/bin/node', args: ['job.js'] },
    environment: [],
    placement: {
      required: {
        architectures: ['arm64'],
        runtimes: [{ name: 'node', versionRange: '^24.0.0' }],
        minMemoryBytes: 256 * 1024 * 1024,
        features: ['artifact-v1'],
      },
      preferred: [{ labels: { region: 'cn-east' }, weight: 7 }],
    },
    createdAtMs: 1,
  });
}

test('canonicalizes bounded capabilities and applies required/preferred placement', () => {
  const value = worker();
  const decision = evaluateRemoteWorkerPlacement(
    value,
    revision().placement,
    20_000,
  );
  assert.deepEqual(decision, { matches: true, score: 7, mismatches: [] });
  assert.deepEqual(
    effectiveRemoteWorkerPlacement({ required: { architectures: ['arm64'] } })
      .required.executors,
    ['remote-worker'],
  );
  assert.throws(
    () => effectiveRemoteWorkerPlacement({ required: { executors: ['docker'] } }),
    /must require remote-worker/,
  );
});

test('rejects non-canonical snapshots and reports bounded mismatch classes', () => {
  const value = worker();
  const reordered = {
    ...value,
    capabilitiesJson: JSON.stringify({
      executors: ['remote-worker'], architecture: 'arm64',
      protocolVersion: '1.0.0', supportTier: 'tier1',
    }),
  };
  reordered.capabilitiesHash = require('node:crypto')
    .createHash('sha256')
    .update(reordered.capabilitiesJson)
    .digest('hex');
  assert.throws(
    () => evaluateRemoteWorkerPlacement(reordered, {}, 1),
    /not canonical/,
  );
  const decision = evaluateRemoteWorkerPlacement(
    value,
    { required: { architectures: ['amd64'], labels: { region: 'eu' } } },
    20_000,
  );
  assert.deepEqual(decision.mismatches, ['architecture', 'label']);
});

test('builds one offer only when candidate, Worker, lease and revision fences agree', () => {
  const executionRevision = revision();
  const candidate = {
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
  };
  const lease = {
    attemptId: 'attempt-1',
    runId: 'run-1',
    status: 'leased',
    version: 0,
    leaseGeneration: 1,
    workerId: 'edge-1',
    workerSessionId: SESSION,
    workerGeneration: 2,
    leaseTokenDigest: digestRunDispatchLeaseToken(TOKEN),
    acquiredAtMs: 20,
    renewedAtMs: 20,
    expiresAtMs: 30_020,
    updatedAtMs: 20,
  };
  const offer = createClusterRemoteExecutionOffer({
    offerId: 'offer-1',
    deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate,
    worker: { workerId: 'edge-1', sessionId: SESSION, generation: 2 },
    lease,
    leaseToken: TOKEN,
    executionRevision,
    placementScore: 7,
  });
  assert.equal(offer.executionRevision.placement.required.executors[0], 'remote-worker');
  assert.throws(
    () => createClusterRemoteExecutionOffer({ ...offer, leaseToken: `${TOKEN}x` }),
    /authority does not match/,
  );
});
