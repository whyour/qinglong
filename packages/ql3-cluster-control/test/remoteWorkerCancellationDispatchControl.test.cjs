'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRemoteWorkerCancellationDispatchControl,
  ClusterRemoteWorkerCancellationDispatchError,
} = require('@qinglong/cluster-control/cancellation-dispatch-control');
const {
  RemoteWorkerLeaseControlUnavailableError,
} = require('@qinglong/runtime-core/remote-worker-lease-control');

const COMMAND = Object.freeze({
  workerId: 'worker-1',
  workerSessionId: '018f0000-0000-7000-8000-000000000001',
  workerGeneration: 2,
  projectId: 'project-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  offerId: 'offer-1',
  leaseGeneration: 3,
  leaseToken: 'worker_generated_lease_capability_0000000000000001',
  expectedLeaseVersion: 4,
});
const STOP = Object.freeze({
  status: 'stop_requested',
  projectId: 'project-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  offerId: 'offer-1',
  leaseGeneration: 3,
  leaseVersion: 5,
  renewedAtMs: 10_000,
  expiresAtMs: 40_000,
  stop: Object.freeze({ reason: 'user', requestedAtMs: 9_000 }),
});

function leasedDispatch() {
  return Object.freeze({
    runId: 'run-1',
    attemptId: 'attempt-1',
    status: 'leased',
    version: 1,
    dispatchCount: 1,
    leaseOwner: 'replica-1',
    leaseTokenDigest: 'a'.repeat(64),
    leaseExpiresAtMs: 40_000,
    createdAtMs: 10_000,
    updatedAtMs: 10_000,
  });
}

function service(dispatches, overrides = {}) {
  return new ClusterRemoteWorkerCancellationDispatchControl(
    {
      async control() {
        return overrides.result ?? STOP;
      },
    },
    dispatches,
    {
      ownerId: 'replica-1',
      leaseDurationMs: 30_000,
      createLeaseToken: () => 'cancel-token-1',
      createEventId: () => '018f0000-0000-7000-8000-000000000011',
      ...(overrides.onObservation === undefined
        ? {}
        : { onObservation: overrides.onObservation }),
      ...(overrides.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: overrides.onDiagnostic }),
    },
  );
}

test('bypasses dispatch storage when lease control only renews', async () => {
  let calls = 0;
  const renewed = Object.freeze({
    ...STOP,
    status: 'renewed',
    stop: undefined,
  });
  const control = service(
    {
      async claim() {
        calls += 1;
        throw new Error('must not claim');
      },
      async recordResult() {
        calls += 1;
        throw new Error('must not record');
      },
    },
    { result: renewed },
  );
  assert.equal(await control.control(COMMAND), renewed);
  assert.equal(calls, 0);
});

test('settles one durable dispatch before releasing a Worker stop', async () => {
  const observed = [];
  let claimCommand;
  let resultCommand;
  const claimed = leasedDispatch();
  const control = service(
    {
      async claim(value) {
        claimCommand = value;
        return { status: 'claimed', dispatch: claimed, leaseToken: 'cancel-token-1' };
      },
      async recordResult(value) {
        resultCommand = value;
        return {
          dispatch: {
            ...claimed,
            status: 'dispatched',
            version: 2,
            leaseOwner: undefined,
            leaseTokenDigest: undefined,
            leaseExpiresAtMs: undefined,
            lastResult: 'termination_requested',
            lastDispatchedAtMs: 10_001,
            updatedAtMs: 10_001,
          },
          event: { type: 'run.cancel_dispatched' },
        };
      },
    },
    { onObservation: (value) => observed.push(value) },
  );

  assert.equal(await control.control(COMMAND), STOP);
  assert.deepEqual(claimCommand, {
    runId: 'run-1',
    attemptId: 'attempt-1',
    requestedAtMs: 9_000,
    owner: 'replica-1',
    leaseToken: 'cancel-token-1',
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(resultCommand, {
    runId: 'run-1',
    attemptId: 'attempt-1',
    owner: 'replica-1',
    leaseToken: 'cancel-token-1',
    expectedVersion: 1,
    result: 'termination_requested',
    eventId: '018f0000-0000-7000-8000-000000000011',
  });
  assert.deepEqual(observed, [{ status: 'dispatched' }]);
});

test('releases an already-dispatched stop without a second result event', async () => {
  let results = 0;
  const observed = [];
  const control = service(
    {
      async claim() {
        return {
          status: 'dispatched',
          dispatch: { ...leasedDispatch(), status: 'dispatched' },
        };
      },
      async recordResult() {
        results += 1;
        throw new Error('must not record');
      },
    },
    { onObservation: (value) => observed.push(value) },
  );
  assert.equal(await control.control(COMMAND), STOP);
  assert.equal(results, 0);
  assert.deepEqual(observed, [{ status: 'already_dispatched' }]);
});

test('keeps a foreign live dispatch from releasing a duplicate stop', async () => {
  const diagnostics = [];
  const observed = [];
  const control = service(
    {
      async claim() {
        return { status: 'leased', dispatch: leasedDispatch() };
      },
      async recordResult() {
        throw new Error('must not record');
      },
    },
    {
      onObservation: (value) => observed.push(value),
      onDiagnostic: (error) => diagnostics.push(error),
    },
  );
  await assert.rejects(
    control.control(COMMAND),
    (error) =>
      error instanceof RemoteWorkerLeaseControlUnavailableError &&
      error.cause instanceof ClusterRemoteWorkerCancellationDispatchError &&
      error.cause.reason === 'delivery_deferred',
  );
  assert.deepEqual(observed, [{ status: 'deferred' }]);
  assert.equal(diagnostics[0].reason, 'delivery_deferred');
});

test('fails closed and reports a durable blocked dispatch', async () => {
  const diagnostics = [];
  const observed = [];
  const control = service(
    {
      async claim() {
        return { status: 'blocked', dispatch: leasedDispatch() };
      },
      async recordResult() {
        throw new Error('must not record');
      },
    },
    {
      onObservation: (value) => observed.push(value),
      onDiagnostic: (error) => diagnostics.push(error),
    },
  );
  await assert.rejects(
    control.control(COMMAND),
    (error) => error.cause?.reason === 'delivery_blocked',
  );
  assert.deepEqual(observed, [{ status: 'blocked' }]);
  assert.equal(diagnostics[0].code, 'CLUSTER_REMOTE_CANCELLATION_DISPATCH_FAILED');
});

test('preserves Workflow-scoped timeout stops without forging Run cancellation', async () => {
  let results = 0;
  const observed = [];
  const control = service(
    {
      async claim() {
        return { status: 'not_eligible' };
      },
      async recordResult() {
        results += 1;
      },
    },
    { onObservation: (value) => observed.push(value) },
  );
  assert.equal(await control.control(COMMAND), STOP);
  assert.equal(results, 0);
  assert.deepEqual(observed, [{ status: 'untracked' }]);
});

test('does not release a stop when durable result settlement fails', async () => {
  const diagnostics = [];
  const control = service(
    {
      async claim() {
        return {
          status: 'claimed',
          dispatch: leasedDispatch(),
          leaseToken: 'cancel-token-1',
        };
      },
      async recordResult() {
        throw new Error('database unavailable');
      },
    },
    { onDiagnostic: (error) => diagnostics.push(error) },
  );
  await assert.rejects(
    control.control(COMMAND),
    (error) => error.cause?.reason === 'result_failed',
  );
  assert.equal(diagnostics[0].reason, 'result_failed');
});

test('rejects widened or unbounded production configuration', () => {
  const repository = { claim() {}, recordResult() {} };
  const leaseControl = { control() {} };
  assert.throws(
    () =>
      new ClusterRemoteWorkerCancellationDispatchControl(
        leaseControl,
        repository,
        { ownerId: '', extra: true },
      ),
    /invalid_configuration/,
  );
  assert.throws(
    () =>
      new ClusterRemoteWorkerCancellationDispatchControl(
        leaseControl,
        repository,
        { ownerId: 'replica-1', leaseDurationMs: 0 },
      ),
    /invalid_configuration/,
  );
});
