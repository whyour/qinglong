const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ClusterControlRecoveryStoreError } = require('@qinglong/runtime-core');
const { PostgresClusterControlRecoveryClaimRepository } = require('../dist');

function sourceRows(observedAtMs = '1000') {
  return [
    {
      observedAtMs,
      kind: 'attempt',
      id: 'attempt-1',
      runId: 'run-1',
      status: 'running',
      createdAtMs: '900',
    },
  ];
}

function claimRows() {
  return [
    {
      targetKind: 'attempt',
      targetId: 'attempt-1',
      runId: 'run-1',
      targetStatus: 'running',
      targetCreatedAtMs: '900',
      observedAtMs: '1000',
      claimOwner: 'replica-a',
      claimToken: '00000000-0000-4000-8000-000000000001',
      claimVersion: 1,
      claimExpiresAtMs: '31000',
    },
  ];
}

test('discovers and claims one bounded page in a short transaction', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes('run_candidates AS')) return { rows: sourceRows() };
      if (text.startsWith('INSERT INTO "ql3"."run_recovery_controls"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FOR UPDATE OF control SKIP LOCKED')) {
        return { rows: claimRows(), rowCount: 1 };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const repository = new PostgresClusterControlRecoveryClaimRepository(
    {
      async connect() {
        return client;
      },
      async query() {
        throw new Error('pool query not expected');
      },
    },
    () => '00000000-0000-4000-8000-000000000001',
  );

  const page = await repository.claim({
    ownerId: 'replica-a',
    limit: 4,
    leaseMs: 30_000,
  });

  assert.equal(page.discovered, 1);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.claims[0], {
    candidate: {
      kind: 'attempt',
      id: 'attempt-1',
      runId: 'run-1',
      status: 'running',
      createdAtMs: 900,
    },
    observedAtMs: 1000,
    ownerId: 'replica-a',
    token: '00000000-0000-4000-8000-000000000001',
    version: 1,
    expiresAtMs: 31000,
  });
  assert.deepEqual(
    calls.map(({ text }) => text.split('\n', 1)[0]),
    [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      'WITH observation AS (',
      'INSERT INTO "ql3"."run_recovery_controls" (',
      'WITH discovered AS (',
      'COMMIT',
    ],
  );
  assert.deepEqual(calls[5].values.slice(1), [
    1000,
    4,
    'replica-a',
    '00000000-0000-4000-8000-000000000001',
    30000,
  ]);
  assert.equal(released, true);
});

test('uses an injected runtime-only discovery source without widening claim authority', async () => {
  let sourceQueryable;
  let sourceLimit;
  const client = {
    async query(text) {
      if (text.startsWith('INSERT INTO "ql3"."run_recovery_controls"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FOR UPDATE OF control SKIP LOCKED')) {
        return { rows: claimRows(), rowCount: 1 };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresClusterControlRecoveryClaimRepository(
    {
      async connect() {
        return client;
      },
      async query() {
        throw new Error('not expected');
      },
    },
    () => '00000000-0000-4000-8000-000000000001',
    (queryable) => {
      sourceQueryable = queryable;
      return {
        async listOutstanding(limit) {
          sourceLimit = limit;
          return {
            observedAtMs: 1000,
            candidates: [{
              kind: 'attempt',
              id: 'attempt-1',
              runId: 'run-1',
              status: 'running',
              createdAtMs: 900,
            }],
            hasMore: false,
          };
        },
      };
    },
  );

  const page = await repository.claim({
    ownerId: 'replica-a',
    limit: 4,
    leaseMs: 30_000,
  });
  assert.equal(sourceQueryable, client);
  assert.equal(sourceLimit, 4);
  assert.equal(page.claims.length, 1);
});

test('rolls back and wraps claim-store failures without leaking the client', async () => {
  const calls = [];
  let released = false;
  const repository = new PostgresClusterControlRecoveryClaimRepository(
    {
      async connect() {
        return {
          async query(text) {
            calls.push(text);
            if (text.includes('run_candidates AS')) throw new Error('offline');
            return { rows: [] };
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
    () => '00000000-0000-4000-8000-000000000002',
  );

  await assert.rejects(
    repository.claim({ ownerId: 'replica-b', limit: 1, leaseMs: 1000 }),
    ClusterControlRecoveryStoreError,
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('settles only under the full owner-token-version-expiry fence', async () => {
  const calls = [];
  const results = [
    { rows: [{ targetId: 'attempt-1' }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ];
  const repository = new PostgresClusterControlRecoveryClaimRepository({
    async connect() {
      throw new Error('not expected');
    },
    async query(text, values) {
      calls.push({ text, values });
      return results.shift();
    },
  });
  const claim = Object.freeze({
    candidate: Object.freeze({
      kind: 'attempt',
      id: 'attempt-1',
      runId: 'run-1',
      status: 'running',
      createdAtMs: 900,
    }),
    observedAtMs: 1000,
    ownerId: 'replica-a',
    token: '00000000-0000-4000-8000-000000000001',
    version: 7,
    expiresAtMs: 31000,
  });

  assert.equal(
    await repository.settle(claim, { status: 'retry', delayMs: 2500 }),
    'settled',
  );
  assert.equal(
    await repository.settle(claim, { status: 'resolved' }),
    'fenced',
  );
  assert.match(
    calls[0].text,
    /claim_expires_at_ms > observation\.observed_at_ms/,
  );
  assert.deepEqual(calls[0].values, [
    'attempt',
    'attempt-1',
    'replica-a',
    '00000000-0000-4000-8000-000000000001',
    7,
    'retry',
    2500,
  ]);
});

test('rejects unsafe options before acquiring a database connection', async () => {
  let connects = 0;
  const repository = new PostgresClusterControlRecoveryClaimRepository({
    async connect() {
      connects += 1;
      throw new Error('not expected');
    },
    async query() {
      throw new Error('not expected');
    },
  });
  await assert.rejects(
    repository.claim({ ownerId: 'bad owner', limit: 1, leaseMs: 1000 }),
    /ownerId is invalid/,
  );
  await assert.rejects(
    repository.claim({ ownerId: 'ok', limit: 129, leaseMs: 1000 }),
    /claim limit/,
  );
  assert.equal(connects, 0);
});
