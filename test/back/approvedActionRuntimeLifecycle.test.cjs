require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ApprovedActionRuntimeLifecycle,
} = require('../../back/runtime/application/approvedActionRuntimeLifecycle');
const {
  ApprovedActionRuntimeSupervisor,
} = require('../../back/runtime/application/approvedActionRuntimeSupervisor');
const {
  localPrimaryResourcePolicy,
} = require('../../back/runtime/domain/deploymentProfile');

function dispatchPage(overrides = {}) {
  return {
    scanned: 1,
    claimed: 1,
    started: 1,
    succeeded: 1,
    failed: 0,
    blocked: 0,
    retrying: 0,
    deferred: 0,
    recoveryRequired: 0,
    alreadyTerminal: 0,
    unavailable: 0,
    truncated: false,
    ...overrides,
  };
}

function recoveryPage(overrides = {}) {
  return {
    scanned: 1,
    claimed: 1,
    verifiedSucceeded: 1,
    verifiedFailed: 0,
    deferred: 0,
    manualRequired: 0,
    executionActive: 0,
    alreadyResolved: 0,
    unavailable: 0,
    truncated: false,
    ...overrides,
  };
}

function runtimeSummary(overrides = {}) {
  return {
    recovery: {
      pages: 1,
      ...recoveryPage(),
      stopReason: 'complete',
      remaining: false,
      ...overrides.recovery,
    },
    dispatch: {
      pages: 1,
      ...dispatchPage(),
      stopReason: 'complete',
      remaining: false,
      ...overrides.dispatch,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('supervisor runs recovery first and aggregates bounded dispatch pages', async () => {
  const calls = [];
  let dispatchPageNumber = 0;
  const supervisor = new ApprovedActionRuntimeSupervisor(
    {
      async dispatchBatch(options) {
        calls.push(['dispatch', options]);
        dispatchPageNumber += 1;
        if (dispatchPageNumber === 1) {
          return dispatchPage({
            truncated: true,
            nextCursor: { eligibleAtMs: 11, dispatchId: 'dispatch-1' },
          });
        }
        return dispatchPage({ claimed: 0, succeeded: 0, unavailable: 1 });
      },
    },
    {
      async reconcileBatch(options) {
        calls.push(['recovery', options]);
        return recoveryPage();
      },
    },
  );
  const summary = await supervisor.runCycle({
    recovery: { pageSize: 4, maxPages: 1 },
    dispatch: { pageSize: 8, maxPages: 2 },
  });
  assert.deepEqual(calls, [
    ['recovery', { limit: 4 }],
    ['dispatch', { limit: 8 }],
    [
      'dispatch',
      {
        cursor: { eligibleAtMs: 11, dispatchId: 'dispatch-1' },
        limit: 8,
      },
    ],
  ]);
  assert.equal(summary.recovery.verifiedSucceeded, 1);
  assert.equal(summary.dispatch.pages, 2);
  assert.equal(summary.dispatch.scanned, 2);
  assert.equal(summary.dispatch.claimed, 1);
  assert.equal(summary.dispatch.succeeded, 1);
  assert.equal(summary.dispatch.unavailable, 1);
  assert.equal(summary.dispatch.remaining, false);
});

test('supervisor exposes page-limit cursors and refuses stalled scans', async () => {
  const dispatchCursor = { eligibleAtMs: 20, dispatchId: 'dispatch-2' };
  const recoveryCursor = { nextScanAtMs: 30, dispatchId: 'dispatch-3' };
  const limited = new ApprovedActionRuntimeSupervisor(
    {
      async dispatchBatch() {
        return dispatchPage({ truncated: true, nextCursor: dispatchCursor });
      },
    },
    {
      async reconcileBatch() {
        return recoveryPage({ truncated: true, nextCursor: recoveryCursor });
      },
    },
  );
  const limitedSummary = await limited.runCycle({
    dispatch: { pageSize: 1, maxPages: 1 },
    recovery: { pageSize: 1, maxPages: 1 },
  });
  assert.equal(limitedSummary.dispatch.stopReason, 'page_limit');
  assert.deepEqual(limitedSummary.dispatch.nextCursor, dispatchCursor);
  assert.equal(limitedSummary.recovery.stopReason, 'page_limit');
  assert.deepEqual(limitedSummary.recovery.nextCursor, recoveryCursor);

  const stalled = new ApprovedActionRuntimeSupervisor(
    {
      async dispatchBatch(options) {
        return dispatchPage({ truncated: true, nextCursor: options.cursor });
      },
    },
    {
      async reconcileBatch() {
        return recoveryPage();
      },
    },
  );
  const stalledSummary = await stalled.runCycle({
    dispatch: { cursor: dispatchCursor, pageSize: 1, maxPages: 2 },
  });
  assert.equal(stalledSummary.dispatch.stopReason, 'cursor_stalled');
  assert.equal(stalledSummary.dispatch.remaining, true);
});

test('recovery storage failure prevents new dispatch work in the same cycle', async () => {
  let dispatchCalls = 0;
  const supervisor = new ApprovedActionRuntimeSupervisor(
    {
      async dispatchBatch() {
        dispatchCalls += 1;
        return dispatchPage();
      },
    },
    {
      async reconcileBatch() {
        throw new Error('recovery index unavailable');
      },
    },
  );
  await assert.rejects(supervisor.runCycle(), /recovery index unavailable/);
  assert.equal(dispatchCalls, 0);
});

test('lifecycle uses one unref timer, never overlaps, and resumes both cursors', async () => {
  const timers = fakeScheduler();
  const first = deferred();
  const calls = [];
  const policy = localPrimaryResourcePolicy('edge').approvedAction;
  const lifecycle = new ApprovedActionRuntimeLifecycle(
    {
      async runCycle(options) {
        calls.push(options);
        if (calls.length === 1) return first.promise;
        return runtimeSummary();
      },
    },
    {
      intervalMs: policy.intervalMs,
      initialDelayMs: policy.initialDelayMs,
      stopTimeoutMs: policy.stopTimeoutMs,
      cycle: {
        dispatch: policy.dispatch,
        recovery: policy.recovery,
      },
      scheduler: timers.scheduler,
    },
  );
  assert.equal(timers.pending.size, 0);
  assert.equal(lifecycle.start(), true);
  assert.equal(lifecycle.start(), false);
  const initial = timers.fireNext();
  assert.equal(initial.delayMs, 0);
  assert.equal(initial.unrefCalls, 1);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(timers.pending.size, 0);
  first.resolve(
    runtimeSummary({
      recovery: {
        remaining: true,
        stopReason: 'page_limit',
        nextCursor: { nextScanAtMs: 40, dispatchId: 'recovery-resume' },
      },
      dispatch: {
        remaining: true,
        stopReason: 'page_limit',
        nextCursor: { eligibleAtMs: 50, dispatchId: 'dispatch-resume' },
      },
    }),
  );
  await flush();
  const next = timers.fireNext();
  assert.equal(next.delayMs, 30_000);
  assert.equal(next.unrefCalls, 1);
  await flush();
  assert.deepEqual(calls[1], {
    recovery: {
      pageSize: 8,
      maxPages: 1,
      cursor: { nextScanAtMs: 40, dispatchId: 'recovery-resume' },
    },
    dispatch: {
      pageSize: 8,
      maxPages: 1,
      cursor: { eligibleAtMs: 50, dispatchId: 'dispatch-resume' },
    },
  });
  assert.equal(await lifecycle.stop(), 'drained');
});

test('lifecycle isolates diagnostics and bounds an in-flight shutdown', async () => {
  const timers = fakeScheduler();
  const running = deferred();
  const errors = [];
  const lifecycle = new ApprovedActionRuntimeLifecycle(
    {
      async runCycle() {
        return running.promise;
      },
    },
    {
      intervalMs: 500,
      stopTimeoutMs: 5,
      scheduler: timers.scheduler,
      onError(error) {
        errors.push(error.message);
      },
    },
  );
  lifecycle.start();
  timers.fireNext();
  await flush();
  assert.equal(await lifecycle.stop(), 'timed_out');
  assert.equal(timers.pending.size, 0);
  assert.equal(lifecycle.start(), false);
  running.resolve(runtimeSummary());
  await flush();
  assert.equal(lifecycle.start(), true);
  assert.equal(await lifecycle.stop(), 'drained');
  assert.deepEqual(errors, []);
});

test('supervisor and lifecycle reject hot loops and unbounded pages', async () => {
  const supervisor = new ApprovedActionRuntimeSupervisor(
    {
      async dispatchBatch() {
        return dispatchPage();
      },
    },
    {
      async reconcileBatch() {
        return recoveryPage();
      },
    },
  );
  await assert.rejects(
    supervisor.runCycle({ dispatch: { maxPages: 65 } }),
    RangeError,
  );
  assert.throws(
    () => new ApprovedActionRuntimeLifecycle(supervisor, { intervalMs: 249 }),
    RangeError,
  );
  assert.throws(
    () =>
      new ApprovedActionRuntimeLifecycle(supervisor, {
        intervalMs: 500,
        stopTimeoutMs: 60_001,
      }),
    RangeError,
  );
});
