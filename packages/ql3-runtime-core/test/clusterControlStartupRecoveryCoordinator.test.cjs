const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlStartupRecoveryCoordinator,
  MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES,
} = require('../dist');

test('runs bounded startup pages until recovery converges', async () => {
  const summaries = [
    { safe: false, remaining: 1, failed: 0 },
    { safe: false, remaining: 1, failed: 0 },
    { safe: true, remaining: 0, failed: 0 },
  ];
  let calls = 0;
  const coordinator = new ClusterControlStartupRecoveryCoordinator(
    {
      async reconcile() {
        return summaries[calls++];
      },
    },
    { maxPasses: 3 },
  );

  assert.deepEqual(await coordinator.reconcile(), summaries[2]);
  assert.equal(calls, 3);
});

test('stops immediately when retry or manual work remains', async () => {
  let calls = 0;
  const coordinator = new ClusterControlStartupRecoveryCoordinator({
    async reconcile() {
      calls += 1;
      return { safe: false, remaining: 2, failed: 1 };
    },
  });

  assert.deepEqual(await coordinator.reconcile(), {
    safe: false,
    remaining: 2,
    failed: 1,
  });
  assert.equal(calls, 1);
});

test('returns the final lower bound when the hard pass budget is exhausted', async () => {
  let calls = 0;
  const coordinator = new ClusterControlStartupRecoveryCoordinator(
    {
      async reconcile() {
        calls += 1;
        return { safe: false, remaining: calls + 1, failed: 0 };
      },
    },
    { maxPasses: 2 },
  );

  assert.deepEqual(await coordinator.reconcile(), {
    safe: false,
    remaining: 3,
    failed: 0,
  });
  assert.equal(calls, 2);
});

test('rejects inconsistent summaries and unbounded configuration', async () => {
  assert.equal(MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES, 64);
  assert.throws(
    () =>
      new ClusterControlStartupRecoveryCoordinator(
        { async reconcile() {} },
        { maxPasses: 65 },
      ),
    /maxPasses/,
  );
  const coordinator = new ClusterControlStartupRecoveryCoordinator({
    async reconcile() {
      return { safe: true, remaining: 1, failed: 0 };
    },
  });
  await assert.rejects(coordinator.reconcile(), /invalid summary/);
});
