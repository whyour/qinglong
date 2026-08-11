require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryRunStartupSupervisor,
} = require('../../back/runtime/application/primaryRunStartupSupervisor');

function page(overrides = {}) {
  return {
    scanned: 1,
    verifiedRunning: 0,
    recoveredRunning: 1,
    completedFromReceipt: 0,
    quarantinedReceipts: 0,
    publishGraceWaits: 0,
    markedLost: 0,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    truncated: false,
    unsafeAttemptOverflow: false,
    ...overrides,
  };
}

test('startup supervisor aggregates bounded pages until recovery completes', async () => {
  const cursors = [];
  const responses = [
    page({
      truncated: true,
      nextCursor: { createdAtMs: 10, runId: 'run-1' },
    }),
    page({ verifiedRunning: 1, recoveredRunning: 0, markedLost: 1 }),
  ];
  const supervisor = new PrimaryRunStartupSupervisor({
    async reconcileBatch(options) {
      cursors.push(options.cursor);
      return responses.shift();
    },
  });

  const result = await supervisor.run({ pageSize: 8, maxPages: 4 });
  assert.deepEqual(cursors, [undefined, { createdAtMs: 10, runId: 'run-1' }]);
  assert.deepEqual(result, {
    pages: 2,
    scanned: 2,
    verifiedRunning: 1,
    recoveredRunning: 1,
    completedFromReceipt: 0,
    quarantinedReceipts: 0,
    publishGraceWaits: 0,
    markedLost: 1,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
  });
});

test('startup supervisor fails closed for overflow, stalled cursor, and page limit', async () => {
  const overflow = new PrimaryRunStartupSupervisor({
    async reconcileBatch() {
      return page({ unsafeAttemptOverflow: true, truncated: true });
    },
  });
  assert.equal((await overflow.run()).stopReason, 'unsafe_attempt_overflow');

  const stalled = new PrimaryRunStartupSupervisor({
    async reconcileBatch() {
      return page({ truncated: true });
    },
  });
  assert.equal((await stalled.run()).stopReason, 'cursor_stalled');

  let sequence = 0;
  const limited = new PrimaryRunStartupSupervisor({
    async reconcileBatch() {
      sequence += 1;
      return page({
        truncated: true,
        nextCursor: { createdAtMs: sequence, runId: `run-${sequence}` },
      });
    },
  });
  const limitedResult = await limited.run({ maxPages: 2 });
  assert.equal(limitedResult.stopReason, 'page_limit');
  assert.equal(limitedResult.remaining, true);
  assert.deepEqual(limitedResult.nextCursor, {
    createdAtMs: 2,
    runId: 'run-2',
  });
});

test('startup supervisor rejects unbounded settings', async () => {
  const supervisor = new PrimaryRunStartupSupervisor({
    async reconcileBatch() {
      return page();
    },
  });
  await assert.rejects(supervisor.run({ pageSize: 0 }), RangeError);
  await assert.rejects(supervisor.run({ maxPages: 65 }), RangeError);
});
