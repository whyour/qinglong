require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerHeartbeatLifecycle,
} = require('../../back/runtime/application/workerHeartbeatLifecycle');
const {
  WorkerFenceRejectedError,
} = require('../../back/runtime/domain/worker');

const SESSION_ID = '019f7600-0000-7000-8000-000000000001';

function capabilities() {
  return {
    architecture: 'x64',
    operatingSystem: 'linux',
    executors: ['local_process'],
    runtimes: [{ name: 'node', version: '24.14.0' }],
    labels: {},
    capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
    features: [],
  };
}

function worker(overrides = {}) {
  return {
    id: 'worker-a',
    sessionId: SESSION_ID,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: capabilities(),
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 1,
    availableSlots: 1,
    registeredAtMs: 1,
    lastHeartbeatAtMs: 1,
    leaseExpiresAtMs: 10_000,
    updatedAtMs: 1,
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
      assert.ok(timer, 'expected a scheduled heartbeat');
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

test('registers once and never overlaps a slow heartbeat', async () => {
  const clock = scheduler();
  const pending = deferred();
  let registrations = 0;
  let heartbeats = 0;
  const lifecycle = new WorkerHeartbeatLifecycle(
    {
      async register() {
        registrations += 1;
        return worker();
      },
      heartbeat() {
        heartbeats += 1;
        return pending.promise;
      },
      async drain() {
        return worker({ status: 'draining', version: 1, availableSlots: 0 });
      },
      async disconnect() {
        return worker({ status: 'offline', version: 1, availableSlots: 0 });
      },
    },
    {
      workerId: 'worker-a',
      capabilities,
      maxConcurrentRuns: 1,
      availableSlots: () => 1,
      heartbeatIntervalMs: 1_000,
      createSessionId: () => SESSION_ID,
      scheduler: clock.value,
    },
  );

  assert.equal(await lifecycle.start(), true);
  assert.equal(await lifecycle.start(), false);
  assert.equal(registrations, 1);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].unrefCalled, true);
  clock.fire();
  await flush();
  assert.equal(heartbeats, 1);
  assert.equal(clock.timers.length, 0);
  pending.resolve(worker({ version: 1, lastHeartbeatAtMs: 2, updatedAtMs: 2 }));
  await flush();
  assert.equal(clock.timers.length, 1);
});

test('fails closed on a fenced heartbeat instead of reclaiming the Worker id', async () => {
  const clock = scheduler();
  const fenced = [];
  let registrations = 0;
  const lifecycle = new WorkerHeartbeatLifecycle(
    {
      async register() {
        registrations += 1;
        return worker();
      },
      async heartbeat() {
        throw new WorkerFenceRejectedError('worker-a', 'session_mismatch');
      },
      async drain() {
        throw new Error('not reached');
      },
      async disconnect() {
        throw new Error('not reached');
      },
    },
    {
      workerId: 'worker-a',
      capabilities,
      maxConcurrentRuns: 1,
      availableSlots: () => 1,
      heartbeatIntervalMs: 1_000,
      createSessionId: () => SESSION_ID,
      scheduler: clock.value,
      onFenced(error) {
        fenced.push(error.reason);
      },
    },
  );

  await lifecycle.start();
  clock.fire();
  await flush();
  assert.deepEqual(fenced, ['session_mismatch']);
  assert.equal(registrations, 1);
  assert.equal(clock.timers.length, 0);
  assert.equal(await lifecycle.start(), true);
  assert.equal(registrations, 2);
});

test('drains capacity before a bounded disconnect', async () => {
  const clock = scheduler();
  const calls = [];
  const lifecycle = new WorkerHeartbeatLifecycle(
    {
      async register() {
        calls.push('register');
        return worker();
      },
      async heartbeat() {
        calls.push('heartbeat');
        return worker({ version: 1 });
      },
      async drain(request) {
        calls.push(['drain', request.expectedVersion]);
        return worker({ status: 'draining', version: 1, availableSlots: 0 });
      },
      async disconnect(request) {
        calls.push(['disconnect', request.expectedVersion]);
        return worker({ status: 'offline', version: 2, availableSlots: 0 });
      },
    },
    {
      workerId: 'worker-a',
      capabilities,
      maxConcurrentRuns: 1,
      availableSlots: () => 1,
      heartbeatIntervalMs: 1_000,
      createSessionId: () => SESSION_ID,
      scheduler: clock.value,
    },
  );

  await lifecycle.start();
  const drained = await lifecycle.drain();
  assert.equal(drained.status, 'draining');
  assert.equal(drained.availableSlots, 0);
  assert.equal(await lifecycle.stop(), 'drained');
  assert.deepEqual(calls, ['register', ['drain', 0], ['disconnect', 1]]);
  assert.equal(lifecycle.currentSession().status, 'offline');
  assert.equal(clock.timers.length, 0);
});

test('serializes stop behind an in-flight drain', async () => {
  const clock = scheduler();
  const pendingDrain = deferred();
  const calls = [];
  const lifecycle = new WorkerHeartbeatLifecycle(
    {
      async register() {
        return worker();
      },
      async heartbeat() {
        throw new Error('not reached');
      },
      drain(request) {
        calls.push(['drain', request.expectedVersion]);
        return pendingDrain.promise;
      },
      async disconnect(request) {
        calls.push(['disconnect', request.expectedVersion]);
        return worker({ status: 'offline', version: 2, availableSlots: 0 });
      },
    },
    {
      workerId: 'worker-a',
      capabilities,
      maxConcurrentRuns: 1,
      availableSlots: () => 1,
      heartbeatIntervalMs: 1_000,
      createSessionId: () => SESSION_ID,
      scheduler: clock.value,
    },
  );

  await lifecycle.start();
  const draining = lifecycle.drain();
  const stopping = lifecycle.stop();
  await flush();
  assert.deepEqual(calls, [['drain', 0]]);
  pendingDrain.resolve(
    worker({ status: 'draining', version: 1, availableSlots: 0 }),
  );
  assert.equal((await draining).status, 'draining');
  assert.equal(await stopping, 'drained');
  assert.deepEqual(calls, [
    ['drain', 0],
    ['disconnect', 1],
  ]);
});

test('does not report a failed disconnect as drained', async () => {
  const lifecycle = new WorkerHeartbeatLifecycle(
    {
      async register() {
        return worker();
      },
      async heartbeat() {
        throw new Error('not reached');
      },
      async drain() {
        return worker({ status: 'draining', version: 1, availableSlots: 0 });
      },
      async disconnect() {
        throw new Error('control plane unavailable');
      },
    },
    {
      workerId: 'worker-a',
      capabilities,
      maxConcurrentRuns: 1,
      availableSlots: () => 1,
      heartbeatIntervalMs: 1_000,
      createSessionId: () => SESSION_ID,
    },
  );

  await lifecycle.start();
  await lifecycle.drain();
  assert.equal(await lifecycle.stop(), 'disconnect_failed');
});
