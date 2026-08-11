const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterRunCancellationConvergenceCoordinator,
  ClusterRunCancellationConvergenceUnavailableError,
  normalizeClusterRunCancellationConvergencePageCommand,
  normalizeClusterRunCancellationConvergencePageResult,
} = require('../dist/run/clusterRunCancellationConvergence');

test('normalizes one exact bounded convergence page command and result', () => {
  assert.deepEqual(
    normalizeClusterRunCancellationConvergencePageCommand({
      limit: 2,
    }),
    { limit: 2 },
  );
  assert.deepEqual(
    normalizeClusterRunCancellationConvergencePageResult({
      scanned: 2,
      settledRuns: 2,
      settledAttempts: 3,
      blocked: 0,
      hasMore: false,
    }, 2),
    {
      scanned: 2,
      settledRuns: 2,
      settledAttempts: 3,
      blocked: 0,
      hasMore: false,
    },
  );
});

test('rejects widened and internally inconsistent page facts', () => {
  assert.throws(() => normalizeClusterRunCancellationConvergencePageCommand({
    limit: 1,
    extra: true,
  }));
  assert.throws(() => normalizeClusterRunCancellationConvergencePageResult({
    scanned: 1,
    settledRuns: 2,
    settledAttempts: 0,
    blocked: 0,
    hasMore: false,
  }, 1));
  assert.throws(() => normalizeClusterRunCancellationConvergencePageResult({
    scanned: 1,
    settledRuns: 1,
    settledAttempts: 129,
    blocked: 0,
    hasMore: false,
  }, 1));
});

test('coalesces callers and aggregates a bounded multi-page cycle', async () => {
  const calls = [];
  let release;
  let page = 0;
  const coordinator = new ClusterRunCancellationConvergenceCoordinator({
    async convergePage(command) {
      calls.push(command);
      page += 1;
      if (page === 1) await new Promise((resolve) => { release = resolve; });
      return page === 1
        ? {
            scanned: 2,
            settledRuns: 2,
            settledAttempts: 1,
            blocked: 0,
            hasMore: true,
          }
        : {
            scanned: 1,
            settledRuns: 1,
            settledAttempts: 0,
            blocked: 0,
            hasMore: false,
          };
    },
  }, {
    pageSize: 2,
    maxPages: 4,
  });

  const first = coordinator.reconcile();
  const second = coordinator.reconcile();
  assert.equal(first, second);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, {
    pages: 2,
    scanned: 3,
    settledRuns: 3,
    settledAttempts: 1,
    blocked: 0,
    hasMore: false,
    remaining: false,
    stopReason: 'complete',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { limit: 2 });
});

test('stops on blocked state and exposes page-limit continuation', async () => {
  const blocked = new ClusterRunCancellationConvergenceCoordinator({
    async convergePage() {
      return {
        scanned: 1,
        settledRuns: 0,
        settledAttempts: 0,
        blocked: 1,
        hasMore: true,
      };
    },
  }, {});
  assert.deepEqual(await blocked.reconcile(), {
    pages: 1,
    scanned: 1,
    settledRuns: 0,
    settledAttempts: 0,
    blocked: 1,
    hasMore: true,
    remaining: true,
    stopReason: 'blocked',
  });

  const limited = new ClusterRunCancellationConvergenceCoordinator({
    async convergePage() {
      return {
        scanned: 1,
        settledRuns: 1,
        settledAttempts: 0,
        blocked: 0,
        hasMore: true,
      };
    },
  }, {
    pageSize: 1,
    maxPages: 2,
  });
  assert.equal((await limited.reconcile()).stopReason, 'page_limit');
});

test('wraps malformed or stalled repositories as unavailable', async () => {
  const coordinator = new ClusterRunCancellationConvergenceCoordinator({
    async convergePage() {
      return {
        scanned: 0,
        settledRuns: 0,
        settledAttempts: 0,
        blocked: 0,
        hasMore: true,
      };
    },
  }, {});
  await assert.rejects(
    coordinator.reconcile(),
    ClusterRunCancellationConvergenceUnavailableError,
  );
});
