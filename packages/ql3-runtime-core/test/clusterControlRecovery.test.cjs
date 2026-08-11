const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlRecoveryConvergenceVerifier,
  MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE,
} = require('../dist');

test('proves convergence with one bounded recovery-source read', async () => {
  const limits = [];
  const verifier = new ClusterControlRecoveryConvergenceVerifier({
    async listOutstanding(limit) {
      limits.push(limit);
      return { observedAtMs: 123, candidates: [], hasMore: false };
    },
  });

  assert.deepEqual(await verifier.verify(), {
    safe: true,
    remaining: 0,
    failed: 0,
  });
  assert.deepEqual(limits, [1]);
  assert.equal(MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE, 128);
});

test('fails closed with a lower-bound remaining count', async () => {
  const verifier = new ClusterControlRecoveryConvergenceVerifier({
    async listOutstanding() {
      return {
        observedAtMs: 123,
        candidates: [
          {
            kind: 'run',
            id: 'run-1',
            runId: 'run-1',
            status: 'running',
            createdAtMs: 1,
          },
        ],
        hasMore: true,
      };
    },
  });

  assert.deepEqual(await verifier.verify(), {
    safe: false,
    remaining: 2,
    failed: 0,
  });
});

test('rejects an internally inconsistent recovery page', async () => {
  const verifier = new ClusterControlRecoveryConvergenceVerifier({
    async listOutstanding() {
      return { observedAtMs: 123, candidates: [], hasMore: true };
    },
  });

  await assert.rejects(verifier.verify(), /hasMore without a candidate/);
});

test('rejects an invalid durable-source observation', async () => {
  const verifier = new ClusterControlRecoveryConvergenceVerifier({
    async listOutstanding() {
      return { observedAtMs: Number.NaN, candidates: [], hasMore: false };
    },
  });

  await assert.rejects(verifier.verify(), /observation is invalid/);
});
