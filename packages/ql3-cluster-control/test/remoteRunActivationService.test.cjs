const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRemoteRunActivationService,
} = require('@qinglong/cluster-control/remote-activation');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const EVENT_IDS = [
  '018f5c64-9b9d-7f1a-8c2d-1234567890a1',
  '018f5c64-9b9d-7f1a-8c2d-1234567890a2',
  '018f5c64-9b9d-7f1a-8c2d-1234567890a3',
  '018f5c64-9b9d-7f1a-8c2d-1234567890a4',
  '018f5c64-9b9d-7f1a-8c2d-1234567890a5',
];

function command() {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
  };
}

test('binds Worker principal and creates server-owned event IDs', async () => {
  const observed = [];
  const repository = {
    async acknowledgeStarting(value) {
      observed.push(['starting', value]);
      return { status: 'applied', snapshot: {} };
    },
    async acknowledgeRunning(value) {
      observed.push(['running', value]);
      return { status: 'applied', snapshot: {} };
    },
    async failStart(value) {
      observed.push(['failed', value]);
      return { status: 'applied', snapshot: {} };
    },
  };
  let sequence = 0;
  const service = new ClusterRemoteRunActivationService(repository, {
    createEventId: () => EVENT_IDS[sequence++],
  });
  const principal = { workerId: 'edge-1' };
  await service.acknowledgeStarting(principal, command());
  await service.acknowledgeRunning(principal, {
    ...command(),
    executorHandle: 'remote:handle-1',
    callbackSequence: 1,
    callbackTokenDigest: 'a'.repeat(64),
  });
  await service.failStart(principal, command());
  assert.deepEqual(observed, [
    ['starting', { ...command(), workerId: 'edge-1', eventId: EVENT_IDS[0] }],
    ['running', {
      ...command(),
      executorHandle: 'remote:handle-1',
      callbackSequence: 1,
      callbackTokenDigest: 'a'.repeat(64),
      workerId: 'edge-1',
      attemptEventId: EVENT_IDS[1],
      runEventId: EVENT_IDS[2],
    }],
    ['failed', {
      ...command(),
      workerId: 'edge-1',
      attemptEventId: EVENT_IDS[3],
      runEventId: EVENT_IDS[4],
    }],
  ]);
});
