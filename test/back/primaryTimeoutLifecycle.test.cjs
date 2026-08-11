require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryTimeoutLifecycle,
} = require('../../back/runtime/application/primaryTimeoutLifecycle');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeScheduler() {
  let id = 0;
  const pending = new Map();
  const cleared = [];
  return {
    pending,
    cleared,
    scheduler: {
      setTimeout(callback, delayMs) {
        const timer = {
          id: ++id,
          delayMs,
          unrefCalls: 0,
          unref() {
            this.unrefCalls += 1;
          },
        };
        pending.set(timer.id, { timer, callback });
        return timer;
      },
      clearTimeout(timer) {
        cleared.push(timer.id);
        pending.delete(timer.id);
      },
    },
    fireNext() {
      const next = pending.values().next().value;
      assert.ok(next, 'expected a scheduled timer');
      pending.delete(next.timer.id);
      next.callback();
      return next.timer;
    },
  };
}

function cycleSummary() {
  return {
    pages: 1,
    scanned: 1,
    accepted: 1,
    alreadyRequested: 0,
    alreadyTerminal: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('is inert until started and never overlaps timeout scans', async () => {
  const timers = fakeScheduler();
  const first = deferred();
  let calls = 0;
  const lifecycle = new PrimaryTimeoutLifecycle(
    {
      async run(options) {
        calls += 1;
        assert.deepEqual(options, { pageSize: 8, maxPages: 2 });
        return first.promise;
      },
    },
    {
      intervalMs: 30_000,
      initialDelayMs: 100,
      cycle: { pageSize: 8, maxPages: 2 },
      scheduler: timers.scheduler,
    },
  );

  assert.equal(timers.pending.size, 0);
  assert.equal(lifecycle.start(), true);
  assert.equal(lifecycle.start(), false);
  const initial = timers.fireNext();
  assert.equal(initial.delayMs, 100);
  assert.equal(initial.unrefCalls, 1);
  await flush();
  assert.equal(calls, 1);
  assert.equal(timers.pending.size, 0);

  first.resolve(cycleSummary());
  await flush();
  const next = timers.pending.values().next().value.timer;
  assert.equal(next.delayMs, 30_000);
  assert.equal(next.unrefCalls, 1);
  assert.equal(await lifecycle.stop(), 'drained');
  assert.deepEqual(timers.cleared, [next.id]);
});

test('reports errors and resumes without callback failure loops', async () => {
  const timers = fakeScheduler();
  const errors = [];
  let calls = 0;
  const lifecycle = new PrimaryTimeoutLifecycle(
    {
      async run() {
        calls += 1;
        if (calls === 1) throw new Error('database busy');
        return cycleSummary();
      },
    },
    {
      intervalMs: 5_000,
      scheduler: timers.scheduler,
      onCycle() {
        throw new Error('metrics sink failed');
      },
      onError(error) {
        errors.push(error.message);
      },
    },
  );

  lifecycle.start();
  timers.fireNext();
  await flush();
  assert.deepEqual(errors, ['database busy']);

  timers.fireNext();
  await flush();
  assert.deepEqual(errors, ['database busy', 'metrics sink failed']);
  assert.equal(await lifecycle.stop(), 'drained');
});

test('bounds shutdown and refuses restart while an old scan is in flight', async () => {
  const timers = fakeScheduler();
  const running = deferred();
  const lifecycle = new PrimaryTimeoutLifecycle(
    {
      async run() {
        return running.promise;
      },
    },
    {
      intervalMs: 5_000,
      stopTimeoutMs: 5,
      scheduler: timers.scheduler,
    },
  );
  lifecycle.start();
  timers.fireNext();
  await flush();

  assert.equal(await lifecycle.stop(), 'timed_out');
  assert.equal(timers.pending.size, 0);
  assert.equal(lifecycle.start(), false);
  running.resolve(cycleSummary());
  await flush();
  assert.equal(lifecycle.start(), true);
  assert.equal(await lifecycle.stop(), 'drained');
});

test('rejects hot loops and unbounded shutdown waits', () => {
  const supervisor = {
    async run() {
      return cycleSummary();
    },
  };
  assert.throws(
    () => new PrimaryTimeoutLifecycle(supervisor, { intervalMs: 249 }),
    RangeError,
  );
  assert.throws(
    () =>
      new PrimaryTimeoutLifecycle(supervisor, {
        intervalMs: 500,
        stopTimeoutMs: 60_001,
      }),
    RangeError,
  );
});
