'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { LocalExecutionControlLifecycle } = require('../dist/control');

test('runs lost retry inside the existing control cadence before cleanup', async () => {
  const calls = [];
  const lifecycle = new LocalExecutionControlLifecycle(
    {
      async process() {
        throw new Error('no completion notifications are expected');
      },
    },
    {
      async scan() {
        calls.push('control');
        return {
          observedAtMs: 100,
          scanned: 0,
          terminal: 0,
          deferred: 0,
          failed: 0,
          truncated: false,
        };
      },
      async drain() {
        return {
          observedAtMs: 100,
          scanned: 0,
          terminal: 0,
          deferred: 0,
          failed: 0,
          remaining: 0,
          pages: 0,
          truncated: false,
        };
      },
    },
    {
      async scan() {
        calls.push('cleanup');
        return {
          scanned: 0,
          removed: 0,
          missing: 0,
          deferred: 0,
          failed: 0,
          truncated: false,
        };
      },
    },
    {
      intervalMs: 5_000,
      pageSize: 4,
      cleanupIntervalMs: 60_000,
      cleanupPageSize: 4,
      stopTimeoutMs: 1_000,
      maxDrainPages: 1,
      lostRetry: {
        async reconcilePage(command) {
          calls.push('lost_retry');
          assert.deepEqual(command, { limit: 2 });
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
      lostRetryPageSize: 2,
      clock: { now: () => 100 },
    },
  );

  const first = lifecycle.runOnce(true);
  const second = lifecycle.runOnce(true);
  assert.equal(first, second);
  assert.deepEqual((await first).lostRetry, {
    scanned: 1,
    scheduled: 1,
    requeued: 0,
    failed: 0,
    raced: 0,
    hasMore: false,
  });
  assert.deepEqual(calls, ['control', 'lost_retry', 'cleanup']);
});
