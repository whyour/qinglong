require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryCompletionReceiptLifecycle,
} = require('../../back/runtime/application/primaryCompletionReceiptLifecycle');
const {
  PrimaryCompletionReceiptScanner,
} = require('../../back/runtime/application/primaryCompletionReceiptScanner');
const {
  PrimaryCompletionReceiptSupervisor,
} = require('../../back/runtime/application/primaryCompletionReceiptSupervisor');

function candidate(runId, attemptId, executorType = 'local_process') {
  return {
    runId,
    attempts: attemptId ? [{ attemptId, executorType }] : [],
  };
}

function page(overrides = {}) {
  return {
    candidates: [],
    truncated: false,
    unsafeAttemptOverflow: false,
    ...overrides,
  };
}

function scan(overrides = {}) {
  return {
    scanned: 1,
    applied: 0,
    alreadyTerminal: 0,
    quarantined: 0,
    purgedQuarantines: 0,
    expiredMissing: 0,
    missing: 1,
    cleanupPending: 0,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    truncated: false,
    unsafeAttemptOverflow: false,
    ...overrides,
  };
}

test('scans only database-discovered local Attempts and isolates failures', async () => {
  const consumed = [];
  const scanner = new PrimaryCompletionReceiptScanner(
    {
      async listCandidates() {
        return page({
          candidates: [
            candidate('run-1', 'applied'),
            candidate('run-2', 'terminal'),
            candidate('run-3', 'missing'),
            candidate('run-4', 'cleanup-pending'),
            candidate('run-5', 'failed'),
            candidate('run-6', 'quarantined'),
            candidate('run-7', 'remote', 'remote_worker'),
            candidate('run-8'),
            {
              runId: 'run-9',
              attempts: [
                { attemptId: 'one', executorType: 'local_process' },
                { attemptId: 'two', executorType: 'local_process' },
              ],
            },
          ],
        });
      },
    },
    {
      async consume(attemptId) {
        consumed.push(attemptId);
        if (attemptId === 'failed') throw new Error('invalid receipt');
        if (attemptId === 'missing') {
          return { status: 'missing', cleaned: false };
        }
        if (attemptId === 'terminal') {
          return { status: 'already_terminal', cleaned: true };
        }
        if (attemptId === 'quarantined') {
          return {
            status: 'quarantined',
            cleaned: true,
            quarantineRef: '.quarantine/quarantined.json',
          };
        }
        return {
          status: 'applied',
          cleaned: attemptId !== 'cleanup-pending',
        };
      },
    },
  );

  assert.deepEqual(await scanner.scanBatch({ limit: 8 }), {
    scanned: 9,
    applied: 2,
    alreadyTerminal: 1,
    quarantined: 1,
    purgedQuarantines: 0,
    expiredMissing: 0,
    missing: 1,
    cleanupPending: 1,
    skipped: 1,
    ambiguous: 2,
    failed: 1,
    truncated: false,
    unsafeAttemptOverflow: false,
  });
  assert.deepEqual(consumed, [
    'applied',
    'terminal',
    'missing',
    'cleanup-pending',
    'failed',
    'quarantined',
  ]);
});

test('supervisor aggregates bounded pages and exposes unsafe pagination', async () => {
  const cursors = [];
  const responses = [
    scan({
      applied: 1,
      missing: 0,
      truncated: true,
      nextCursor: { createdAtMs: 10, runId: 'run-1' },
    }),
    scan({ alreadyTerminal: 1, cleanupPending: 1 }),
  ];
  const supervisor = new PrimaryCompletionReceiptSupervisor({
    async scanBatch(options) {
      cursors.push(options.cursor);
      return responses.shift();
    },
  });
  assert.deepEqual(await supervisor.run({ pageSize: 8, maxPages: 4 }), {
    pages: 2,
    scanned: 2,
    applied: 1,
    alreadyTerminal: 1,
    quarantined: 0,
    purgedQuarantines: 0,
    expiredMissing: 0,
    missing: 1,
    cleanupPending: 1,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
  });
  assert.deepEqual(cursors, [undefined, { createdAtMs: 10, runId: 'run-1' }]);

  const overflow = new PrimaryCompletionReceiptSupervisor({
    async scanBatch() {
      return scan({ unsafeAttemptOverflow: true, truncated: true });
    },
  });
  assert.equal((await overflow.run()).stopReason, 'unsafe_attempt_overflow');
  await assert.rejects(supervisor.run({ pageSize: 0 }), RangeError);
  await assert.rejects(supervisor.run({ maxPages: 65 }), RangeError);
});

test('lifecycle is explicit, unrefed, and never overlaps a slow scan', async () => {
  const scheduled = [];
  const scheduler = {
    setTimeout(callback, delayMs) {
      const timer = {
        callback,
        delayMs,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
  };
  let release;
  let runs = 0;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });
  const lifecycle = new PrimaryCompletionReceiptLifecycle(
    {
      async run() {
        runs += 1;
        await inFlight;
        return {};
      },
    },
    { intervalMs: 1_000, scheduler },
  );

  assert.equal(lifecycle.start(), true);
  assert.equal(lifecycle.start(), false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].unrefCalled, true);
  scheduled[0].callback();
  scheduled[0].callback();
  assert.equal(runs, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 2);
  assert.equal(await lifecycle.stop(), 'drained');
  assert.equal(scheduled[1].cleared, true);
});

test('lifecycle resumes after a page limit and resets after reaching the tail', async () => {
  const scheduled = [];
  const scheduler = {
    setTimeout(callback) {
      const timer = { callback, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout() {},
  };
  const cursors = [];
  let runs = 0;
  const lifecycle = new PrimaryCompletionReceiptLifecycle(
    {
      async run(options) {
        runs += 1;
        cursors.push(options.cursor);
        if (runs === 1) {
          return {
            remaining: true,
            nextCursor: { createdAtMs: 10, runId: 'run-10' },
          };
        }
        return { remaining: false };
      },
    },
    { intervalMs: 1_000, scheduler },
  );

  lifecycle.start();
  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  await lifecycle.stop();
  assert.deepEqual(cursors, [
    undefined,
    { createdAtMs: 10, runId: 'run-10' },
    undefined,
  ]);
});
