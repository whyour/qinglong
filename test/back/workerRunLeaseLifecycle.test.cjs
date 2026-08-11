require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerRunLeaseLifecycle,
} = require('../../back/runtime/application/workerRunLeaseLifecycle');
const {
  RunDispatchLeaseFenceRejectedError,
} = require('../../back/runtime/domain/runDispatchLease');

const START = 1_760_100_000_000;
const SESSION_A = '019f7b00-0000-7000-8000-000000000001';
const SESSION_B = '019f7b00-0000-7000-8000-000000000002';
const TOKEN = 'worker_run_lease_token_abcdefghijklmnopqrstuvwxyz0123456789';

function worker(overrides = {}) {
  return {
    id: 'worker-a',
    sessionId: SESSION_A,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
      features: [],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 1,
    availableSlots: 1,
    registeredAtMs: START,
    lastHeartbeatAtMs: START,
    leaseExpiresAtMs: START + 60_000,
    updatedAtMs: START,
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
    attemptId: '019f7b00-0000-7000-8000-000000000010',
    runId: '019f7b00-0000-7000-8000-000000000011',
    status: 'leased',
    version: 0,
    leaseGeneration: 1,
    workerId: 'worker-a',
    workerSessionId: SESSION_A,
    workerGeneration: 1,
    leaseToken: TOKEN,
    acquiredAtMs: START,
    renewedAtMs: START,
    expiresAtMs: START + 5_000,
    updatedAtMs: START,
    ...overrides,
  };
}

function scheduler() {
  const timers = [];
  return {
    timers,
    value: {
      setTimeout(callback, delayMs) {
        const timer = {
          callback,
          delayMs,
          unrefCalled: false,
          unref() {
            this.unrefCalled = true;
          },
        };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        const index = timers.indexOf(timer);
        if (index !== -1) timers.splice(index, 1);
      },
    },
    fire() {
      const timer = timers.shift();
      assert.ok(timer, 'expected a scheduled Run lease renewal');
      timer.callback();
      return timer;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('uses one unref timer and never overlaps renewal', async () => {
  let nowMs = START;
  const clock = scheduler();
  const pending = deferred();
  const calls = [];
  const renewed = [];
  const lifecycle = new WorkerRunLeaseLifecycle(
    {
      renew(request) {
        calls.push(request);
        return pending.promise;
      },
      async release() {
        throw new Error('not reached');
      },
    },
    {
      currentSession: () => worker(),
      clock: { now: () => nowMs },
      scheduler: clock.value,
      onRenewed(value) {
        renewed.push(value.version);
      },
    },
  );
  lifecycle.track(lease());
  assert.equal(lifecycle.start(), true);
  assert.equal(lifecycle.start(), false);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].delayMs, 2_500);
  assert.equal(clock.timers[0].unrefCalled, true);
  nowMs = START + 2_500;
  clock.fire();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(clock.timers.length, 0);
  pending.resolve(
    lease({
      version: 1,
      renewedAtMs: nowMs,
      expiresAtMs: nowMs + 5_000,
      updatedAtMs: nowMs,
    }),
  );
  await flush();
  assert.deepEqual(renewed, [1]);
  assert.equal(lifecycle.leases()[0].version, 1);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].delayMs, 2_500);
});

test('retries transient failures only within the current lease window', async () => {
  let nowMs = START;
  const clock = scheduler();
  const errors = [];
  const lost = [];
  let calls = 0;
  const lifecycle = new WorkerRunLeaseLifecycle(
    {
      async renew() {
        calls += 1;
        throw new Error('transport unavailable');
      },
      async release() {
        throw new Error('not reached');
      },
    },
    {
      currentSession: () => worker(),
      clock: { now: () => nowMs },
      scheduler: clock.value,
      retryDelayMs: 1_000,
      onError(error) {
        errors.push(error.message);
      },
      onLost(loss) {
        lost.push(loss.reason);
      },
    },
  );
  lifecycle.track(lease());
  lifecycle.start();
  nowMs = START + 2_500;
  clock.fire();
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(errors, ['transport unavailable']);
  assert.equal(clock.timers[0].delayMs, 1_000);
  nowMs = START + 5_000;
  clock.fire();
  await flush();
  assert.deepEqual(lost, ['lease_expired']);
  assert.equal(lifecycle.leases().length, 0);
  assert.equal(clock.timers.length, 0);
});

test('fails closed when the control plane fences the lease', async () => {
  let nowMs = START;
  const clock = scheduler();
  const lost = [];
  const lifecycle = new WorkerRunLeaseLifecycle(
    {
      async renew() {
        throw new RunDispatchLeaseFenceRejectedError(
          lease().attemptId,
          'version_mismatch',
        );
      },
      async release() {
        throw new Error('not reached');
      },
    },
    {
      currentSession: () => worker(),
      clock: { now: () => nowMs },
      scheduler: clock.value,
      onLost(loss) {
        lost.push(loss.reason);
      },
    },
  );
  lifecycle.track(lease());
  lifecycle.start();
  nowMs = START + 2_500;
  clock.fire();
  await flush();
  assert.deepEqual(lost, ['fenced']);
  assert.deepEqual(lifecycle.leases(), []);
});

test('drops all authority when the Worker session is replaced', async () => {
  let nowMs = START;
  let current = worker();
  const clock = scheduler();
  const lost = [];
  let renewCalls = 0;
  const lifecycle = new WorkerRunLeaseLifecycle(
    {
      async renew() {
        renewCalls += 1;
        throw new Error('not reached');
      },
      async release() {
        throw new Error('not reached');
      },
    },
    {
      currentSession: () => current,
      clock: { now: () => nowMs },
      scheduler: clock.value,
      onLost(loss) {
        lost.push(loss.reason);
      },
    },
  );
  lifecycle.track(lease());
  lifecycle.start();
  current = worker({ sessionId: SESSION_B, generation: 2 });
  nowMs = START + 2_500;
  clock.fire();
  await flush();
  assert.equal(renewCalls, 0);
  assert.deepEqual(lost, ['worker_session_replaced']);
});

test('bounds tracked state by Worker concurrency and releases latest fences', async () => {
  const clock = scheduler();
  const releases = [];
  const lifecycle = new WorkerRunLeaseLifecycle(
    {
      async renew() {
        throw new Error('not reached');
      },
      async release(request) {
        releases.push(request);
        return {
          lease: {
            ...lease(),
            status: 'released',
            version: 1,
            releasedAtMs: START + 1,
            releaseReason: request.reason,
            updatedAtMs: START + 1,
          },
        };
      },
    },
    {
      currentSession: () => worker(),
      clock: { now: () => START },
      scheduler: clock.value,
    },
  );
  lifecycle.track(lease());
  assert.throws(
    () =>
      lifecycle.track(
        lease({
          attemptId: '019f7b00-0000-7000-8000-000000000020',
          runId: '019f7b00-0000-7000-8000-000000000021',
          leaseToken:
            'worker_run_lease_token_second_abcdefghijklmnopqrstuvwxyz012345',
        }),
      ),
    /exceed Worker concurrency/,
  );
  lifecycle.start();
  const released = await lifecycle.releaseAll('shutdown');
  assert.equal(released.length, 1);
  assert.equal(releases[0].expectedVersion, 0);
  assert.equal(releases[0].reason, 'shutdown');
  assert.deepEqual(lifecycle.leases(), []);
  assert.equal(await lifecycle.stop(), 'stopped');
});

test('serializes shutdown release behind an in-flight renewal', async () => {
  let nowMs = START;
  const clock = scheduler();
  const pending = deferred();
  const releases = [];
  const lifecycle = new WorkerRunLeaseLifecycle(
    {
      renew() {
        return pending.promise;
      },
      async release(request) {
        releases.push(request);
        return {
          lease: {
            ...lease(),
            status: 'released',
            version: 2,
            renewedAtMs: START + 2_500,
            expiresAtMs: START + 7_500,
            releasedAtMs: START + 2_501,
            releaseReason: request.reason,
            updatedAtMs: START + 2_501,
          },
        };
      },
    },
    {
      currentSession: () => worker(),
      clock: { now: () => nowMs },
      scheduler: clock.value,
    },
  );
  lifecycle.track(lease());
  lifecycle.start();
  nowMs = START + 2_500;
  clock.fire();
  await flush();
  const releasing = lifecycle.releaseAll('shutdown');
  await flush();
  assert.equal(releases.length, 0);
  pending.resolve(
    lease({
      version: 1,
      renewedAtMs: START + 2_500,
      expiresAtMs: START + 7_500,
      updatedAtMs: START + 2_500,
    }),
  );
  const released = await releasing;
  assert.equal(releases.length, 1);
  assert.equal(releases[0].expectedVersion, 1);
  assert.equal(released[0].version, 2);
  assert.deepEqual(lifecycle.leases(), []);
});
