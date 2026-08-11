require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryTimeoutSupervisor,
} = require('../../back/runtime/application/primaryTimeoutSupervisor');

function summary(overrides = {}) {
  return {
    scanned: 1,
    accepted: 1,
    alreadyRequested: 0,
    alreadyTerminal: 0,
    failed: 0,
    truncated: false,
    ...overrides,
  };
}

test('aggregates bounded timeout pages with one fixed observation time', async () => {
  const calls = [];
  const responses = [
    summary({
      truncated: true,
      nextCursor: { deadlineAtMs: 10, attemptId: 'attempt-1' },
    }),
    summary({ accepted: 0, alreadyTerminal: 1 }),
  ];
  const supervisor = new PrimaryTimeoutSupervisor({
    async requestBatch(options) {
      calls.push(options);
      return responses.shift();
    },
  });

  const result = await supervisor.run({ nowMs: 100, pageSize: 8, maxPages: 4 });
  assert.deepEqual(calls, [
    { nowMs: 100, limit: 8 },
    {
      nowMs: 100,
      cursor: { deadlineAtMs: 10, attemptId: 'attempt-1' },
      limit: 8,
    },
  ]);
  assert.deepEqual(result, {
    pages: 2,
    scanned: 2,
    accepted: 1,
    alreadyRequested: 0,
    alreadyTerminal: 1,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
  });
});

test('samples its clock once when the caller omits an observation time', async () => {
  const calls = [];
  let clockCalls = 0;
  const responses = [
    summary({
      truncated: true,
      nextCursor: { deadlineAtMs: 10, attemptId: 'attempt-1' },
    }),
    summary(),
  ];
  const supervisor = new PrimaryTimeoutSupervisor(
    {
      async requestBatch(options) {
        calls.push(options);
        return responses.shift();
      },
    },
    {
      now() {
        clockCalls += 1;
        return 123;
      },
    },
  );

  await supervisor.run({ pageSize: 8 });
  assert.equal(clockCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].nowMs, 123);
  assert.equal(calls[1].nowMs, 123);
});

test('fails closed for a stalled cursor and bounded page exhaustion', async () => {
  const stalledCursor = { deadlineAtMs: 10, attemptId: 'attempt-1' };
  const stalled = new PrimaryTimeoutSupervisor({
    async requestBatch() {
      return summary({ truncated: true, nextCursor: stalledCursor });
    },
  });
  assert.deepEqual(await stalled.run({ cursor: stalledCursor }), {
    pages: 1,
    scanned: 1,
    accepted: 1,
    alreadyRequested: 0,
    alreadyTerminal: 0,
    failed: 0,
    stopReason: 'cursor_stalled',
    remaining: true,
    nextCursor: stalledCursor,
  });

  let sequence = 0;
  const limited = new PrimaryTimeoutSupervisor({
    async requestBatch() {
      sequence += 1;
      return summary({
        truncated: true,
        nextCursor: {
          deadlineAtMs: sequence,
          attemptId: `attempt-${sequence}`,
        },
      });
    },
  });
  const limitedResult = await limited.run({ maxPages: 2 });
  assert.equal(limitedResult.stopReason, 'page_limit');
  assert.equal(limitedResult.remaining, true);
  assert.deepEqual(limitedResult.nextCursor, {
    deadlineAtMs: 2,
    attemptId: 'attempt-2',
  });
});

test('rejects unbounded timeout supervisor settings', async () => {
  const supervisor = new PrimaryTimeoutSupervisor({
    async requestBatch() {
      return summary();
    },
  });
  await assert.rejects(supervisor.run({ pageSize: 0 }), /pageSize/);
  await assert.rejects(supervisor.run({ maxPages: 65 }), /maxPages/);
  await assert.rejects(supervisor.run({ nowMs: -1 }), /nowMs/);
});
