const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidRunAttemptLogRetentionError,
  RunAttemptLogRetentionService,
  createRunAttemptLogRetirementRecord,
  normalizeRunAttemptLogRetirementRecord,
} = require('../dist/run/log-retention/runAttemptLogRetention.js');

function candidate(index = 1) {
  return {
    projectId: 'prj_default',
    runId: `run_${index}`,
    attemptId: `attempt_${index}`,
    logArtifactId: `local-${String(index).padStart(30, 'a')}`,
    executorType: 'local_process',
    finishedAtMs: index,
  };
}

test('creates tamper-evident exact retirement records', () => {
  const record = createRunAttemptLogRetirementRecord({
    ...candidate(),
    eligibleAtMs: 2,
    retiredAtMs: 3,
    disposition: 'deleted',
    byteLength: 10,
    truncation: { truncated: true, maximumBytes: 64, observedAtMs: 1 },
  });
  assert.match(record.recordDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(normalizeRunAttemptLogRetirementRecord(record), record);
  assert.throws(
    () =>
      normalizeRunAttemptLogRetirementRecord({
        ...record,
        byteLength: 11,
      }),
    InvalidRunAttemptLogRetentionError,
  );
});

test('uses pressure policy and persists a bounded resume cursor', async () => {
  let saved;
  const recorded = [];
  const values = [candidate(1), candidate(2), candidate(3)];
  const service = new RunAttemptLogRetentionService(
    {
      async inspect() {
        return { status: 'active' };
      },
      async loadCursor() {
        return undefined;
      },
      async list(input) {
        assert.equal(input.cutoffMs, 9 * 60_000);
        assert.equal(input.limit, 3);
        return {
          candidates: values,
          truncated: false,
        };
      },
      async record(record) {
        recorded.push(record);
        return 'recorded';
      },
      async saveCursor(cursor) {
        saved = cursor;
      },
    },
    {
      async retire(value) {
        return {
          disposition: 'deleted',
          byteLength: value.finishedAtMs,
          truncation: { truncated: 'unknown' },
        };
      },
    },
    {
      async inspect() {
        return { availableBytes: 9n, totalBytes: 100n };
      },
    },
    {
      normalRetentionMs: 5 * 60_000,
      pressureRetentionMs: 60_000,
      minimumFreeBytes: 10,
      pageSize: 3,
      maximumDeletions: 2,
      clock: { now: () => 10 * 60_000 },
    },
  );
  const result = await service.sweep();
  assert.equal(result.status, 'deletion_budget_exhausted');
  assert.equal(result.pressure, true);
  assert.equal(result.deletionsAttempted, 2);
  assert.equal(result.bytesReclaimed, 3);
  assert.equal(recorded.length, 2);
  assert.deepEqual(saved, { finishedAtMs: 2, attemptId: 'attempt_2' });
});

test('advances past failures and clears the cursor after a complete page', async () => {
  const saved = [];
  const service = new RunAttemptLogRetentionService(
    {
      async inspect() {
        return { status: 'active' };
      },
      async loadCursor() {
        return { finishedAtMs: 1, attemptId: 'attempt_1' };
      },
      async list() {
        return { candidates: [candidate(2)], truncated: false };
      },
      async record() {
        throw new Error('database unavailable');
      },
      async saveCursor(cursor) {
        saved.push(cursor);
      },
    },
    {
      async retire() {
        return {
          disposition: 'already_absent',
          byteLength: 0,
          truncation: { truncated: 'unknown' },
        };
      },
    },
    {
      async inspect() {
        return { availableBytes: 100n, totalBytes: 100n };
      },
    },
    {
      normalRetentionMs: 60_000,
      pressureRetentionMs: 60_000,
      minimumFreeBytes: 0,
      pageSize: 2,
      maximumDeletions: 2,
      clock: { now: () => 10 * 60_000 },
    },
  );
  const result = await service.sweep();
  assert.equal(result.failedCandidates, 1);
  assert.equal(result.entries[0].outcome, 'record_failed');
  assert.deepEqual(saved, [undefined]);
});
