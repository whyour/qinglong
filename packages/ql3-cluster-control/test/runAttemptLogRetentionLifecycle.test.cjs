'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRunAttemptLogRetentionCoordinator,
  ClusterRunAttemptLogRetentionLifecycle,
} = require('../dist/run/runAttemptLogRetentionLifecycle');

function claim(overrides = {}) {
  return Object.freeze({
    candidate: Object.freeze({
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      logArtifactId: `wlog-${'a'.repeat(30)}`,
      executorType: 'remote_worker',
      finishedAtMs: 1_000,
    }),
    eligibleAtMs: 61_000,
    observedAtMs: 70_000,
    ownerId: 'replica-a',
    token: '00000000-0000-4000-8000-000000000055',
    version: 1,
    expiresAtMs: 100_000,
    failureCount: 0,
    ...overrides,
  });
}

function options(overrides = {}) {
  return {
    ownerId: 'replica-a',
    retentionMs: 60_000,
    claimLimit: 4,
    leaseMs: 30_000,
    maximumCycleMs: 10_000,
    retryBaseMs: 1_000,
    retryMaximumMs: 8_000,
    maximumFailures: 3,
    ...overrides,
  };
}

function coordinator({
  claims = [claim()],
  hasMore = false,
  retire,
  settle,
} = {}) {
  const calls = [];
  const value = new ClusterRunAttemptLogRetentionCoordinator(
    {
      async claim(input) {
        calls.push(['claim', input]);
        return { claims, hasMore };
      },
      async settle(current, settlement) {
        calls.push(['settle', current, settlement]);
        return (await settle?.(current, settlement)) ?? 'settled';
      },
      async inspect() {
        return { status: 'active' };
      },
    },
    {
      async retire(candidate, signal) {
        calls.push(['retire', candidate, signal]);
        return (
          (await retire?.(candidate, signal)) ?? {
            disposition: 'deleted',
            byteLength: 11,
            truncation: { truncated: false },
          }
        );
      },
    },
    options(),
  );
  return { calls, coordinator: value };
}

test('claims one bounded page and records exact DB-clock retirement evidence', async () => {
  const { calls, coordinator: value } = coordinator({
    claims: [
      claim(),
      claim({
        candidate: Object.freeze({
          ...claim().candidate,
          attemptId: 'attempt-2',
          logArtifactId: `wlog-${'b'.repeat(30)}`,
        }),
      }),
    ],
    hasMore: true,
    retire(candidate) {
      return candidate.attemptId === 'attempt-1'
        ? {
            disposition: 'deleted',
            byteLength: 11,
            truncation: { truncated: false },
          }
        : {
            disposition: 'already_absent',
            byteLength: 0,
            truncation: { truncated: 'unknown' },
          };
    },
  });

  const summary = await value.runOnce();
  assert.deepEqual(summary, {
    status: 'saturated',
    claimed: 2,
    attempted: 2,
    retired: 1,
    alreadyAbsent: 1,
    retried: 0,
    manual: 0,
    fenced: 0,
    hasMore: true,
    entries: [
      { attemptId: 'attempt-1', outcome: 'deleted' },
      { attemptId: 'attempt-2', outcome: 'already_absent' },
    ],
  });
  assert.deepEqual(calls[0][1], {
    ownerId: 'replica-a',
    retentionMs: 60_000,
    limit: 4,
    leaseMs: 30_000,
  });
  const records = calls
    .filter(([kind]) => kind === 'settle')
    .map(([, , settlement]) => settlement.record);
  assert.equal(records[0].retiredAtMs, 70_000);
  assert.equal(records[0].recordDigest.length, 64);
  assert.equal(records[1].byteLength, 0);
});

test('uses bounded exponential retry then moves repeated failures to manual', async () => {
  const first = claim({ failureCount: 2 });
  const second = claim({
    candidate: Object.freeze({
      ...claim().candidate,
      attemptId: 'attempt-2',
      logArtifactId: `wlog-${'b'.repeat(30)}`,
    }),
    failureCount: 1,
  });
  const { calls, coordinator: value } = coordinator({
    claims: [first, second],
    retire(candidate) {
      const error = new Error('object drift');
      if (candidate.attemptId === 'attempt-1')
        error.reason = 'integrity_mismatch';
      throw error;
    },
  });

  const summary = await value.runOnce();
  assert.equal(summary.manual, 1);
  assert.equal(summary.retried, 1);
  const settlements = calls
    .filter(([kind]) => kind === 'settle')
    .map(([, , settlement]) => settlement);
  assert.deepEqual(settlements, [
    { status: 'manual', failureCode: 'artifact_integrity_mismatch' },
    {
      status: 'retry',
      delayMs: 2_000,
      failureCode: 'artifact_unavailable',
    },
  ]);
});

test('classifies malformed retirement evidence and preserves a fenced settlement', async () => {
  const { coordinator: value } = coordinator({
    retire() {
      return {
        disposition: 'already_absent',
        byteLength: 5,
        truncation: { truncated: 'unknown' },
      };
    },
    settle() {
      return 'fenced';
    },
  });
  const summary = await value.runOnce();
  assert.equal(summary.fenced, 1);
  assert.deepEqual(summary.entries, [
    { attemptId: 'attempt-1', outcome: 'fenced' },
  ]);
});

test('cycle budget aborts object work and leaves the durable claim for takeover', async () => {
  let settlements = 0;
  const value = new ClusterRunAttemptLogRetentionCoordinator(
    {
      async claim() {
        return { claims: [claim()], hasMore: false };
      },
      async settle() {
        settlements += 1;
        return 'settled';
      },
      async inspect() {
        return { status: 'active' };
      },
    },
    {
      retire(_candidate, signal) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
    options({ maximumCycleMs: 100 }),
  );
  const summary = await value.runOnce();
  assert.equal(summary.status, 'budget_exhausted');
  assert.equal(summary.attempted, 1);
  assert.equal(settlements, 0);
});

test('lifecycle coalesces cycles and aborts one in-flight object call on drain', async () => {
  let calls = 0;
  let observedAbort = false;
  const lifecycle = new ClusterRunAttemptLogRetentionLifecycle(
    {
      runOnce(signal) {
        calls += 1;
        return new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              resolve({ status: 'budget_exhausted' });
            },
            { once: true },
          );
        });
      },
    },
    { intervalMs: 60_000, stopTimeoutMs: 1_000 },
  );
  const first = lifecycle.runOnce();
  assert.equal(lifecycle.runOnce(), first);
  assert.equal(await lifecycle.stopAndDrain(), 'stopped');
  await first;
  assert.equal(calls, 1);
  assert.equal(observedAbort, true);
  await assert.rejects(lifecycle.runOnce(), /is stopping/);
});

test('rejects configurations that can outlive the lease settlement budget', () => {
  const dependencies = [
    { claim() {}, settle() {}, inspect() {} },
    { retire() {} },
  ];
  assert.throws(
    () =>
      new ClusterRunAttemptLogRetentionCoordinator(
        dependencies[0],
        dependencies[1],
        options({ leaseMs: 5_000, maximumCycleMs: 4_501 }),
      ),
    /cycle budget/,
  );
  assert.throws(
    () =>
      new ClusterRunAttemptLogRetentionLifecycle(
        { runOnce() {} },
        { intervalMs: 999, stopTimeoutMs: 1_000 },
      ),
    /lifecycle options/,
  );
});
