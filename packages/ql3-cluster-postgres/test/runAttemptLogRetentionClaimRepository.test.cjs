'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRunAttemptLogRetirementRecord,
  RunAttemptLogRetentionUnavailableError,
} = require('@qinglong/runtime-core/run-attempt-log-retention');
const {
  PostgresRunAttemptLogRetentionClaimRepository,
} = require('../dist/entrypoints/runtime');

const TOKEN = '00000000-0000-4000-8000-000000000055';
const ARTIFACT_ID = `wlog-${'a'.repeat(30)}`;

function claimRow(overrides = {}) {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    logArtifactId: ARTIFACT_ID,
    executorType: 'remote_worker',
    finishedAtMs: '1000',
    eligibleAtMs: '61000',
    observedAtMs: '70000',
    claimOwner: 'replica-a',
    claimToken: TOKEN,
    claimVersion: 1,
    claimExpiresAtMs: '100000',
    failureCount: 0,
    ...overrides,
  };
}

function claim() {
  return Object.freeze({
    candidate: Object.freeze({
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      logArtifactId: ARTIFACT_ID,
      executorType: 'remote_worker',
      finishedAtMs: 1000,
    }),
    eligibleAtMs: 61000,
    observedAtMs: 70000,
    ownerId: 'replica-a',
    token: TOKEN,
    version: 1,
    expiresAtMs: 100000,
    failureCount: 0,
  });
}

test('claims one bounded remote log page under a short database lease', async () => {
  const calls = [];
  let released = false;
  const repository = new PostgresRunAttemptLogRetentionClaimRepository(
    {
      async connect() {
        return {
          async query(text, values = []) {
            calls.push({ text, values });
            if (text.includes('FOR UPDATE OF attempt SKIP LOCKED')) {
              return { rows: [claimRow()], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {
            released = true;
          },
        };
      },
      async query() {
        throw new Error('pool query not expected');
      },
    },
    () => TOKEN,
  );

  const page = await repository.claim({
    ownerId: 'replica-a',
    retentionMs: 60000,
    limit: 4,
    leaseMs: 30000,
  });

  assert.deepEqual(page, { claims: [claim()], hasMore: false });
  assert.deepEqual(
    calls.map(({ text }) => text.split('\n', 1)[0]),
    [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      'WITH observation AS (',
      'COMMIT',
    ],
  );
  assert.deepEqual(calls[3].values, [
    60000,
    4,
    'replica-a',
    TOKEN,
    30000,
  ]);
  assert.match(calls[3].text, /ON CONFLICT \(attempt_id\) DO UPDATE/);
  assert.match(calls[3].text, /claim_expires_at_ms <= EXCLUDED\.updated_at_ms/);
  assert.equal(released, true);
});

test('fences retry settlement by owner token version and database expiry', async () => {
  const calls = [];
  const repository = new PostgresRunAttemptLogRetentionClaimRepository({
    async connect() {
      throw new Error('not expected');
    },
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ attemptId: 'attempt-1' }], rowCount: 1 };
    },
  });

  assert.equal(
    await repository.settle(claim(), {
      status: 'retry',
      delayMs: 2500,
      failureCode: 'artifact_unavailable',
    }),
    'settled',
  );
  assert.deepEqual(calls[0].values, [
    'attempt-1',
    'replica-a',
    TOKEN,
    1,
    100000,
    'retry',
    2500,
    'artifact_unavailable',
  ]);
  assert.match(calls[0].text, /claim_expires_at_ms > observation\.observed_at_ms/);
});

test('reads an exact durable tombstone for the profile-aware log route', async () => {
  const record = createRunAttemptLogRetirementRecord({
    ...claim().candidate,
    eligibleAtMs: 61000,
    retiredAtMs: 80000,
    disposition: 'already_absent',
    byteLength: 0,
    truncation: { truncated: 'unknown' },
  });
  const rows = [
    {
      ...record,
      finishedAtMs: String(record.finishedAtMs),
      eligibleAtMs: String(record.eligibleAtMs),
      retiredAtMs: String(record.retiredAtMs),
      byteLength: String(record.byteLength),
      truncated: 'unknown',
      maximumBytes: null,
      truncationObservedAtMs: null,
    },
  ];
  const repository = new PostgresRunAttemptLogRetentionClaimRepository({
    async connect() {
      throw new Error('not expected');
    },
    async query(text, values) {
      assert.match(text, /artifact_tombstones/);
      assert.deepEqual(values, [ARTIFACT_ID]);
      return { rows: rows.splice(0), rowCount: 1 };
    },
  });
  const identity = {
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    logArtifactId: ARTIFACT_ID,
  };

  assert.deepEqual(await repository.inspect(identity), {
    status: 'retired',
    record,
  });
  assert.deepEqual(await repository.inspect(identity), { status: 'active' });
});

test('records the exact tombstone and removes its claim atomically', async () => {
  const record = createRunAttemptLogRetirementRecord({
    ...claim().candidate,
    eligibleAtMs: 61000,
    retiredAtMs: 80000,
    disposition: 'deleted',
    byteLength: 11,
    truncation: {
      truncated: false,
      maximumBytes: 1048576,
      observedAtMs: 80000,
    },
  });
  const calls = [];
  let released = false;
  const repository = new PostgresRunAttemptLogRetentionClaimRepository({
    async connect() {
      return {
        async query(text, values = []) {
          calls.push({ text, values });
          if (text.includes('FOR UPDATE OF control')) {
            return {
              rows: [claimRow({ observedAtMs: '80000' })],
              rowCount: 1,
            };
          }
          if (text.startsWith('INSERT INTO "ql3"."run_attempt_log_artifact_tombstones"')) {
            return {
              rows: [{ recordDigest: record.recordDigest }],
              rowCount: 1,
            };
          }
          if (text.startsWith('DELETE FROM "ql3"."run_attempt_log_retention_controls"')) {
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {
          released = true;
        },
      };
    },
    async query() {
      throw new Error('not expected');
    },
  });

  assert.equal(
    await repository.settle(claim(), { status: 'retired', record }),
    'settled',
  );
  assert.deepEqual(
    calls.map(({ text }) => text.split('\n', 1)[0]),
    [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      'WITH observation AS (',
      'INSERT INTO "ql3"."run_attempt_log_artifact_tombstones" (',
      'DELETE FROM "ql3"."run_attempt_log_retention_controls"',
      'COMMIT',
    ],
  );
  assert.equal(calls[4].values.at(-1), record.recordDigest);
  assert.equal(released, true);
});

test('returns fenced without writing when the durable lease changed', async () => {
  const calls = [];
  const repository = new PostgresRunAttemptLogRetentionClaimRepository({
    async connect() {
      return {
        async query(text) {
          calls.push(text);
          if (text.includes('FOR UPDATE OF control')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
    async query() {
      throw new Error('not expected');
    },
  });
  const record = createRunAttemptLogRetirementRecord({
    ...claim().candidate,
    eligibleAtMs: 61000,
    retiredAtMs: 80000,
    disposition: 'already_absent',
    byteLength: 0,
    truncation: { truncated: 'unknown' },
  });

  assert.equal(
    await repository.settle(claim(), { status: 'retired', record }),
    'fenced',
  );
  assert.equal(
    calls.some((text) => text.includes('artifact_tombstones" (')),
    false,
  );
});

test('rolls back and wraps claim failures without leaking the client', async () => {
  const calls = [];
  let released = false;
  const repository = new PostgresRunAttemptLogRetentionClaimRepository(
    {
      async connect() {
        return {
          async query(text) {
            calls.push(text);
            if (text.includes('FOR UPDATE OF attempt')) throw new Error('offline');
            return { rows: [], rowCount: 0 };
          },
          release() {
            released = true;
          },
        };
      },
      async query() {
        throw new Error('not expected');
      },
    },
    () => TOKEN,
  );

  await assert.rejects(
    repository.claim({
      ownerId: 'replica-a',
      retentionMs: 60000,
      limit: 1,
      leaseMs: 5000,
    }),
    RunAttemptLogRetentionUnavailableError,
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});
