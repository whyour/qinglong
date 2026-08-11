require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryCompletionReceiptJournalScanner,
} = require('../../back/runtime/application/primaryCompletionReceiptJournalScanner');

const NOW = 1_751_000_000_000;

function candidate(attemptId, overrides = {}) {
  return {
    attemptId,
    runId: `run-${attemptId}`,
    state: 'pending',
    registeredAtMs: NOW - 1_000,
    updatedAtMs: NOW - 1_000,
    attemptStatus: 'running',
    executorType: 'local_process',
    ...overrides,
  };
}

test('scans pending journal rows and expires only old terminal missing receipts', async () => {
  const resolved = [];
  const consumed = [];
  const scanner = new PrimaryCompletionReceiptJournalScanner(
    {
      async listCandidates() {
        return {
          candidates: [
            candidate('applied'),
            candidate('terminal'),
            candidate('missing-active'),
            candidate('missing-terminal', {
              attemptStatus: 'succeeded',
              finishedAtMs: NOW - 61_000,
            }),
            candidate('quarantined'),
            candidate('remote', { executorType: 'remote_worker' }),
            candidate('failed'),
          ],
          truncated: false,
        };
      },
      async resolve(attemptId) {
        resolved.push(attemptId);
        return true;
      },
    },
    {},
    {
      async consume(attemptId) {
        consumed.push(attemptId);
        if (attemptId === 'failed') throw new Error('transient database error');
        if (attemptId.startsWith('missing')) {
          return { status: 'missing', cleaned: false };
        }
        if (attemptId === 'terminal') {
          return { status: 'already_terminal', cleaned: true };
        }
        if (attemptId === 'quarantined') {
          return { status: 'quarantined', cleaned: true };
        }
        return { status: 'applied', cleaned: true };
      },
    },
    { terminalMissingRetentionMs: 60_000, clock: { now: () => NOW } },
  );

  assert.deepEqual(await scanner.scanBatch({ limit: 8 }), {
    scanned: 7,
    applied: 1,
    alreadyTerminal: 1,
    quarantined: 1,
    purgedQuarantines: 0,
    expiredMissing: 1,
    missing: 1,
    cleanupPending: 0,
    skipped: 1,
    ambiguous: 0,
    failed: 1,
    truncated: false,
    unsafeAttemptOverflow: false,
  });
  assert.deepEqual(resolved, ['missing-terminal']);
  assert.deepEqual(consumed, [
    'applied',
    'terminal',
    'missing-active',
    'missing-terminal',
    'quarantined',
    'failed',
  ]);
});

test('purges due quarantine through a known Attempt path and advances cursor', async () => {
  const calls = [];
  const scanner = new PrimaryCompletionReceiptJournalScanner(
    {
      async listCandidates(options) {
        calls.push(['list', options.cursor]);
        return {
          candidates: [
            candidate('due', {
              state: 'quarantined',
              quarantineRef: '.quarantine/du/due.json',
              purgeAfterMs: NOW,
            }),
          ],
          truncated: true,
          nextCursor: { updatedAtMs: NOW - 1, attemptId: 'due' },
        };
      },
      async resolve(attemptId) {
        calls.push(['resolve', attemptId]);
        return true;
      },
    },
    {
      async quarantine(attemptId) {
        calls.push(['quarantine', attemptId]);
        return '.quarantine/du/due.json';
      },
      async purgeQuarantine(attemptId) {
        calls.push(['purge', attemptId]);
        return true;
      },
    },
    { async consume() {} },
    { clock: { now: () => NOW } },
  );

  const result = await scanner.scanBatch({
    cursor: { createdAtMs: NOW - 2, runId: 'before' },
  });
  assert.equal(result.purgedQuarantines, 1);
  assert.deepEqual(result.nextCursor, {
    createdAtMs: NOW - 1,
    runId: 'due',
  });
  assert.deepEqual(calls, [
    ['list', { updatedAtMs: NOW - 2, attemptId: 'before' }],
    ['quarantine', 'due'],
    ['purge', 'due'],
    ['resolve', 'due'],
  ]);
});
