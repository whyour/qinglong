'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidRemoteWorkerLeaseControlError,
  createRemoteWorkerLeaseControlRequestBody,
  createRemoteWorkerLeaseControlResponseBody,
  parseRemoteWorkerLeaseControlRequestBody,
  parseRemoteWorkerLeaseControlResponse,
} = require('../dist/remote-execution/remoteWorkerLeaseControl');

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

test('round-trips one path-bound lease control request', () => {
  const body = createRemoteWorkerLeaseControlRequestBody(command());
  assert.equal(body.schema, 'qinglong/remote-worker-lease-control@v1');
  assert.equal('workerId' in body, false);
  assert.equal('workerSessionId' in body, false);
  assert.deepEqual(parseRemoteWorkerLeaseControlRequestBody(body, {
    workerId: 'worker-1',
    workerSessionId: SESSION_ID,
  }), command());
});

test('round-trips renewed, stop and terminal responses', () => {
  const common = {
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
  };
  for (const result of [
    {
      ...common,
      status: 'renewed',
      leaseVersion: 5,
      renewedAtMs: 100,
      expiresAtMs: 30_100,
    },
    {
      ...common,
      status: 'stop_requested',
      leaseVersion: 5,
      renewedAtMs: 100,
      expiresAtMs: 30_100,
      stop: { reason: 'timeout', requestedAtMs: 99 },
    },
    {
      ...common,
      status: 'terminal',
      terminalStatus: 'cancelled',
    },
  ]) {
    assert.deepEqual(
      parseRemoteWorkerLeaseControlResponse(Buffer.from(JSON.stringify(
        createRemoteWorkerLeaseControlResponseBody(result),
      ))),
      result,
    );
  }
});

test('rejects widened or internally inconsistent control envelopes', () => {
  const body = createRemoteWorkerLeaseControlRequestBody(command());
  assert.throws(
    () => parseRemoteWorkerLeaseControlRequestBody(
      { ...body, workerId: 'worker-1' },
      { workerId: 'worker-1', workerSessionId: SESSION_ID },
    ),
    InvalidRemoteWorkerLeaseControlError,
  );
  assert.throws(
    () => createRemoteWorkerLeaseControlResponseBody({
      status: 'stop_requested',
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      offerId: 'offer-1',
      leaseGeneration: 3,
      leaseVersion: 5,
      renewedAtMs: 100,
      expiresAtMs: 30_100,
    }),
    InvalidRemoteWorkerLeaseControlError,
  );
});
