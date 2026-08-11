const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LocalCompletionReceiptCleanupLifecycle,
  LocalCompletionReceiptCleanupScanner,
} = require('../dist');

function journal(candidates) {
  const resolved = [];
  return {
    resolved,
    async listCandidates() {
      return {
        candidates,
        truncated: false,
        ...(candidates.length === 0
          ? {}
          : {
              nextCursor: {
                updatedAtMs: candidates.at(-1).updatedAtMs,
                attemptId: candidates.at(-1).attemptId,
              },
            }),
      };
    },
    async resolve(attemptId) {
      resolved.push(attemptId);
      return true;
    },
    async register() {},
    async markQuarantined() {},
  };
}

function candidate(attemptId, state, attemptStatus, extra = {}) {
  return {
    attemptId,
    runId: `run-${attemptId}`,
    state,
    attemptStatus,
    executorType: 'local_process',
    registeredAtMs: 1,
    updatedAtMs: 2,
    ...extra,
  };
}

test('cleans only terminal database-indexed receipts and preserves active work', async () => {
  const active = '019f70e0-0000-7000-8000-000000000010';
  const terminal = '019f70e0-0000-7000-8000-000000000011';
  const missing = '019f70e0-0000-7000-8000-000000000012';
  const source = journal([
    candidate(active, 'pending', 'running'),
    candidate(terminal, 'pending', 'succeeded', { finishedAtMs: 5 }),
    candidate(missing, 'pending', 'failed', { finishedAtMs: 5 }),
  ]);
  const removed = [];
  const scanner = new LocalCompletionReceiptCleanupScanner(
    source,
    {
      async remove(attemptId) {
        removed.push(attemptId);
        return attemptId === terminal;
      },
      async read() {},
      async publish() {},
    },
    { clock: { now: () => 100 }, terminalMissingRetentionMs: 10 },
  );
  assert.deepEqual(await scanner.scan(), {
    scanned: 3,
    removed: 1,
    expiredMissing: 1,
    purgedQuarantines: 0,
    remaining: 1,
    failed: 0,
    truncated: false,
    nextCursor: { updatedAtMs: 2, attemptId: missing },
  });
  assert.deepEqual(removed, [terminal, missing]);
  assert.deepEqual(source.resolved, [terminal, missing]);
});

test('completes a durable quarantine intent before purging it', async () => {
  const attemptId = '019f70e0-0000-7000-8000-000000000013';
  const source = journal([
    candidate(attemptId, 'quarantined', 'failed', {
      quarantineRef: `.quarantine/01/${attemptId}.json`,
      purgeAfterMs: 5,
      finishedAtMs: 4,
    }),
  ]);
  const calls = [];
  const scanner = new LocalCompletionReceiptCleanupScanner(source, {
    async remove() {
      return false;
    },
    async read() {},
    async publish() {},
    async quarantine(value) {
      calls.push(`quarantine:${value}`);
    },
    async purgeQuarantine(value) {
      calls.push(`purge:${value}`);
      return true;
    },
  });
  const summary = await scanner.scan();
  assert.equal(summary.purgedQuarantines, 1);
  assert.deepEqual(calls, [`quarantine:${attemptId}`, `purge:${attemptId}`]);
  assert.deepEqual(source.resolved, [attemptId]);
});

test('cleanup lifecycle is explicit and stop is idempotent without a live timer', async () => {
  const scanner = new LocalCompletionReceiptCleanupScanner(journal([]), {
    async remove() {
      return false;
    },
    async read() {},
    async publish() {},
  });
  const lifecycle = new LocalCompletionReceiptCleanupLifecycle(scanner, {
    intervalMs: 60_000,
    pageSize: 8,
  });
  assert.equal((await lifecycle.runOnce()).scanned, 0);
  lifecycle.start();
  assert.equal(await lifecycle.stop(), 'stopped');
  assert.equal(await lifecycle.stop(), 'stopped');
});
