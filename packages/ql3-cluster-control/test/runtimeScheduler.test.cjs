'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterRuntimeSchedulerCoordinator,
} = require('../dist/scheduling/runtimeScheduler');

function schedulerSummary() {
  return Object.freeze({
    firstClaimAcquiredAtMs: null,
    lastClaimAcquiredAtMs: null,
    claimed: 0,
    initialized: 0,
    skipped: 0,
    admitted: 0,
    raced: 0,
    saturated: false,
  });
}

test('orders recovery and lost retry before the existing scheduler cadence', async () => {
  const calls = [];
  const coordinator = new ClusterRuntimeSchedulerCoordinator(
    {
      async reconcile() {
        calls.push('recovery');
        return { safe: true, remaining: 0, failed: 0 };
      },
    },
    {
      async reconcile() {
        calls.push('lost-retry');
        return {
          scanned: 1,
          scheduled: 1,
          requeued: 0,
          failed: 0,
          raced: 0,
          hasMore: false,
        };
      },
    },
    {
      async scheduleOnce() {
        calls.push('schedule');
        return schedulerSummary();
      },
    },
  );

  assert.deepEqual(await coordinator.scheduleOnce(), schedulerSummary());
  assert.deepEqual(calls, ['recovery', 'lost-retry', 'schedule']);
  assert.deepEqual(coordinator.latestMaintenanceSummary(), {
    recovery: { safe: true, remaining: 0, failed: 0 },
    lostRetry: {
      scanned: 1,
      scheduled: 1,
      requeued: 0,
      failed: 0,
      raced: 0,
      hasMore: false,
    },
  });
});

test('coalesces overlapping cadence calls and fails closed before scheduling', async () => {
  let release;
  let recoveryCalls = 0;
  let schedulerCalls = 0;
  const coordinator = new ClusterRuntimeSchedulerCoordinator(
    {
      async reconcile() {
        recoveryCalls += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
        throw new Error('recovery unavailable');
      },
    },
    {
      async reconcile() {
        throw new Error('lost retry must not run');
      },
    },
    {
      async scheduleOnce() {
        schedulerCalls += 1;
        return schedulerSummary();
      },
    },
  );
  const first = coordinator.scheduleOnce();
  const second = coordinator.scheduleOnce();
  assert.equal(first, second);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await assert.rejects(first, /recovery unavailable/);
  assert.equal(recoveryCalls, 1);
  assert.equal(schedulerCalls, 0);
  assert.equal(coordinator.latestMaintenanceSummary(), undefined);
});

test('rejects incomplete maintenance capabilities', () => {
  assert.throws(
    () =>
      new ClusterRuntimeSchedulerCoordinator(
        {},
        { reconcile() {} },
        { scheduleOnce() {} },
      ),
    /runtime scheduler coordinator is invalid/,
  );
});
