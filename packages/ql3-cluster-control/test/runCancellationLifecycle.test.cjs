'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRunCancellationConvergenceLifecycle,
} = require('../dist/run/runCancellationLifecycle');

function summary() {
  return {
    pages: 1,
    scanned: 1,
    settledRuns: 1,
    settledAttempts: 0,
    blocked: 0,
    hasMore: false,
    remaining: false,
    stopReason: 'complete',
  };
}

test('coalesces one bounded cycle and drains without owning per-Run timers', async () => {
  let release;
  let calls = 0;
  const lifecycle = new ClusterRunCancellationConvergenceLifecycle({
    async reconcile() {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return summary();
    },
  }, { intervalMs: 10_000, stopTimeoutMs: 1_000 });
  assert.equal(lifecycle.start(), 'started');
  const first = lifecycle.runOnce();
  const second = lifecycle.runOnce();
  assert.equal(first, second);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, summary());
  assert.equal(calls, 1);
  assert.deepEqual(await lifecycle.stopAndDrain(), { status: 'stopped' });
  await assert.rejects(lifecycle.runOnce(), /stopping/);
});

test('reports a bounded drain timeout without cancelling database authority', async () => {
  const lifecycle = new ClusterRunCancellationConvergenceLifecycle({
    reconcile: () => new Promise(() => {}),
  }, { intervalMs: 10_000, stopTimeoutMs: 100 });
  lifecycle.start();
  void lifecycle.runOnce();
  assert.deepEqual(await lifecycle.stopAndDrain(), { status: 'timed_out' });
});

test('rejects an unbounded cadence configuration', () => {
  assert.throws(() => new ClusterRunCancellationConvergenceLifecycle({
    async reconcile() { return summary(); },
  }, { intervalMs: 249, stopTimeoutMs: 1_000 }));
});
