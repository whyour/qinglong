require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryCancellationSupervisor,
} = require('../../back/runtime/application/primaryCancellationSupervisor');

function summary(overrides = {}) {
  return {
    scanned: 1,
    claimed: 1,
    terminationRequested: 1,
    alreadyExited: 0,
    pending: 0,
    ambiguous: 0,
    blocked: 0,
    deferred: 0,
    alreadyResolved: 0,
    notEligible: 0,
    failed: 0,
    truncated: false,
    unsafeAttemptOverflow: false,
    ...overrides,
  };
}

test('paginates a bounded cancellation recovery cycle and aggregates results', async () => {
  const calls = [];
  const pages = [
    summary({
      scanned: 2,
      claimed: 1,
      pending: 1,
      truncated: true,
      nextCursor: { requestedAtMs: 100, runId: 'run-2' },
    }),
    summary({
      scanned: 2,
      claimed: 2,
      terminationRequested: 0,
      alreadyExited: 1,
      blocked: 1,
    }),
  ];
  const supervisor = new PrimaryCancellationSupervisor({
    async dispatchBatch(options) {
      calls.push(options);
      return pages.shift();
    },
  });

  const result = await supervisor.runCycle({ pageSize: 2, maxPages: 4 });
  assert.deepEqual(calls, [
    { limit: 2 },
    { cursor: { requestedAtMs: 100, runId: 'run-2' }, limit: 2 },
  ]);
  assert.deepEqual(result, {
    pages: 2,
    scanned: 4,
    claimed: 3,
    terminationRequested: 1,
    alreadyExited: 1,
    pending: 1,
    ambiguous: 0,
    blocked: 1,
    deferred: 0,
    alreadyResolved: 0,
    notEligible: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
  });
});

test('stops at the page limit and exposes a resume cursor', async () => {
  let page = 0;
  const supervisor = new PrimaryCancellationSupervisor({
    async dispatchBatch() {
      page += 1;
      return summary({
        truncated: true,
        nextCursor: { requestedAtMs: 100 + page, runId: `run-${page}` },
      });
    },
  });

  const result = await supervisor.runCycle({ pageSize: 1, maxPages: 2 });
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'page_limit');
  assert.equal(result.remaining, true);
  assert.deepEqual(result.nextCursor, {
    requestedAtMs: 102,
    runId: 'run-2',
  });

  const resumedCalls = [];
  const resumed = new PrimaryCancellationSupervisor({
    async dispatchBatch(options) {
      resumedCalls.push(options);
      return summary();
    },
  });
  await resumed.runCycle({ cursor: result.nextCursor, pageSize: 1 });
  assert.deepEqual(resumedCalls, [
    {
      cursor: { requestedAtMs: 102, runId: 'run-2' },
      limit: 1,
    },
  ]);
});

test('fails closed when attempt rows overflow or pagination cannot advance', async () => {
  const unsafe = new PrimaryCancellationSupervisor({
    async dispatchBatch() {
      return summary({
        scanned: 0,
        claimed: 0,
        terminationRequested: 0,
        truncated: true,
        unsafeAttemptOverflow: true,
      });
    },
  });
  const unsafeResult = await unsafe.runCycle();
  assert.equal(unsafeResult.stopReason, 'unsafe_attempt_overflow');
  assert.equal(unsafeResult.remaining, true);

  const stalled = new PrimaryCancellationSupervisor({
    async dispatchBatch() {
      return summary({ truncated: true });
    },
  });
  const stalledResult = await stalled.runCycle();
  assert.equal(stalledResult.stopReason, 'cursor_stalled');
  assert.equal(stalledResult.remaining, true);
});

test('rejects unbounded cycle settings', async () => {
  const supervisor = new PrimaryCancellationSupervisor({
    async dispatchBatch() {
      throw new Error('must not run');
    },
  });
  await assert.rejects(supervisor.runCycle({ pageSize: 65 }), RangeError);
  await assert.rejects(supervisor.runCycle({ maxPages: 65 }), RangeError);
});
