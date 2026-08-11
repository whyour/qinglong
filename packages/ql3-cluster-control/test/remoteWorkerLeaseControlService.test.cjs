'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRemoteWorkerLeaseControlService,
} = require('@qinglong/cluster-control/lease-control');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';

function command() {
  return {
    workerId: 'worker-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: LEASE_TOKEN,
    expectedLeaseVersion: 4,
  };
}

test('adds server-owned renewal duration and timeout Event authority', async () => {
  let observed;
  const service = new ClusterRemoteWorkerLeaseControlService({
    async control(value) {
      observed = value;
      return {
        status: 'renewed',
        projectId: value.projectId,
        runId: value.runId,
        attemptId: value.attemptId,
        offerId: value.offerId,
        leaseGeneration: value.leaseGeneration,
        leaseVersion: value.expectedLeaseVersion + 1,
        renewedAtMs: 10_000,
        expiresAtMs: 55_000,
      };
    },
  }, {
    leaseDurationMs: 45_000,
    createEventId: () => '018f0000-0000-7000-8000-000000000011',
  });

  assert.deepEqual(await service.control(command()), {
    status: 'renewed',
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseVersion: 5,
    renewedAtMs: 10_000,
    expiresAtMs: 55_000,
  });
  assert.deepEqual(observed, {
    ...command(),
    leaseDurationMs: 45_000,
    timeoutEventId: '018f0000-0000-7000-8000-000000000011',
  });
});

test('fails closed before repository access for invalid server Event IDs', async () => {
  let calls = 0;
  const service = new ClusterRemoteWorkerLeaseControlService({
    async control() { calls += 1; throw new Error('must not run'); },
  }, { createEventId: () => '' });
  await assert.rejects(service.control(command()), /unavailable/);
  assert.equal(calls, 0);
});

test('rejects a repository response that drifts from the wire contract', async () => {
  const service = new ClusterRemoteWorkerLeaseControlService({
    async control(value) {
      return {
        status: 'renewed',
        projectId: value.projectId,
        runId: value.runId,
        attemptId: value.attemptId,
        offerId: value.offerId,
        leaseGeneration: value.leaseGeneration,
        leaseVersion: value.expectedLeaseVersion + 1,
        renewedAtMs: 10_000,
        expiresAtMs: 10_000,
      };
    },
  });
  await assert.rejects(service.control(command()), /invalid/);
});
