require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RunDispatchLeaseExpiryScanner,
} = require('../../back/runtime/application/runDispatchLeaseExpiryScanner');

const NOW = 1_761_000_000_000;

function candidate(sequence, overrides = {}) {
  return {
    runId: `run-${sequence}`,
    attemptId: `attempt-${sequence}`,
    expiresAtMs: NOW - 100 + sequence,
    ...overrides,
  };
}

test('isolates one reconciliation failure and exposes a stable resume cursor', async () => {
  const calls = [];
  const scanner = new RunDispatchLeaseExpiryScanner(
    {
      async listExpired(options) {
        calls.push(['list', options]);
        return [candidate(1), candidate(2), candidate(3)];
      },
    },
    {
      async reconcile(runId, attemptId) {
        calls.push(['reconcile', runId, attemptId]);
        if (attemptId === 'attempt-2') throw new Error('transient failure');
        return {
          status:
            attemptId === 'attempt-1' ? 'lost' : 'cancellation_pending',
        };
      },
    },
    { clock: { now: () => NOW } },
  );
  const summary = await scanner.scan({ limit: 3 });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.counts.lost, 1);
  assert.equal(summary.counts.cancellation_pending, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.nextCursor, {
    expiresAtMs: NOW - 99,
    attemptId: 'attempt-1',
  });
  assert.equal(calls.filter(([name]) => name === 'reconcile').length, 2);
});

test('rejects oversized, unordered, live and stalled source pages', async () => {
  const service = { async reconcile() { return { status: 'lost' }; } };
  for (const records of [
    [candidate(1), candidate(2)],
    [candidate(2), candidate(1)],
    [candidate(1, { expiresAtMs: NOW + 1 })],
    [candidate(1, { expiresAtMs: NOW - 10, attemptId: 'attempt-0' })],
  ]) {
    const scanner = new RunDispatchLeaseExpiryScanner(
      { async listExpired() { return records; } },
      service,
      { clock: { now: () => NOW } },
    );
    if (records.length > 1 && records[0].attemptId === 'attempt-1') {
      await assert.rejects(scanner.scan({ limit: 1 }), /exceeded page size/);
    } else if (records[0].expiresAtMs > NOW) {
      await assert.rejects(scanner.scan(), /cursor did not advance/);
    } else if (records[0].attemptId === 'attempt-0') {
      await assert.rejects(
        scanner.scan({
          after: { expiresAtMs: NOW - 10, attemptId: 'attempt-0' },
        }),
        /cursor did not advance/,
      );
    } else {
      await assert.rejects(scanner.scan(), /cursor did not advance/);
    }
  }
});

test('bounds page size and rejects an invalid observation clock', async () => {
  const source = { async listExpired() { return []; } };
  const service = { async reconcile() { return { status: 'not_found' }; } };
  const scanner = new RunDispatchLeaseExpiryScanner(source, service, {
    clock: { now: () => NOW },
  });
  await assert.rejects(scanner.scan({ limit: 0 }), /limit must be between/);
  await assert.rejects(scanner.scan({ limit: 65 }), /limit must be between/);
  await assert.rejects(
    new RunDispatchLeaseExpiryScanner(source, service, {
      clock: { now: () => -1 },
    }).scan(),
    /observedAtMs/,
  );
});
