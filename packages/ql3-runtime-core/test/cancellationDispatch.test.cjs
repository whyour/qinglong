const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = require('../dist');
const contract = require('../dist/run/cancellation-dispatch/cancellationDispatch');

const RUN_ID = '019f71c0-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f71c0-0000-7000-8000-000000000002';
const EVENT_ID = '019f71c0-0000-7000-8000-000000000003';
const TOKEN_DIGEST =
  'bf9dbe4700121e13b366bba7adbdfbb5a29d7e4b7a4b8d9181acd45b38c9a8bf';

function pendingRecord(overrides = {}) {
  return {
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    status: 'pending',
    version: 0,
    dispatchCount: 0,
    nextAttemptAtMs: 1_750_000_000_100,
    createdAtMs: 1_750_000_000_100,
    updatedAtMs: 1_750_000_000_100,
    ...overrides,
  };
}

test('normalizes database-timed claim and result commands with exact bounds', () => {
  const claim = contract.normalizeClaimCancellationDispatchCommand({
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    requestedAtMs: 1_750_000_000_100,
    owner: 'primary-a',
    leaseToken: 'lease-a',
    leaseDurationMs: contract.MAX_CANCELLATION_DISPATCH_LEASE_MS,
  });
  assert.equal(Object.isFrozen(claim), true);
  assert.equal('nowMs' in claim, false);

  const result = contract.normalizeRecordCancellationDispatchResultCommand({
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    owner: 'primary-a',
    leaseToken: 'lease-a',
    expectedVersion: 1,
    result: 'dispatch_error',
    retryDelayMs: contract.MAX_CANCELLATION_DISPATCH_RETRY_DELAY_MS,
    eventId: EVENT_ID,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal('atMs' in result, false);
  assert.equal('nextAttemptAtMs' in result, false);

  assert.throws(
    () =>
      contract.normalizeClaimCancellationDispatchCommand({
        ...claim,
        nowMs: 1_750_000_000_100,
      }),
    contract.InvalidCancellationDispatchCommandError,
  );
  assert.throws(
    () =>
      contract.normalizeRecordCancellationDispatchResultCommand({
        ...result,
        retryDelayMs: 0,
      }),
    contract.InvalidCancellationDispatchCommandError,
  );
  assert.throws(
    () =>
      contract.normalizeRecordCancellationDispatchResultCommand({
        ...result,
        result: 'already_exited',
      }),
    contract.InvalidCancellationDispatchCommandError,
  );
});

test('domain-separates lease digests and never admits a raw token into records', () => {
  assert.equal(
    contract.digestCancellationDispatchLeaseToken('lease-a'),
    TOKEN_DIGEST,
  );
  assert.match(TOKEN_DIGEST, /^[0-9a-f]{64}$/);

  const { nextAttemptAtMs: _nextAttemptAtMs, ...pending } = pendingRecord();
  const leased = contract.normalizeCancellationDispatchRecord(
    {
      ...pending,
      status: 'leased',
      version: 1,
      dispatchCount: 1,
      leaseOwner: 'primary-a',
      leaseTokenDigest: TOKEN_DIGEST,
      leaseExpiresAtMs: 1_750_000_000_200,
    },
  );
  assert.equal(leased.leaseTokenDigest, TOKEN_DIGEST);
  assert.equal('leaseToken' in leased, false);
  assert.throws(
    () =>
      contract.normalizeCancellationDispatchRecord({
        ...leased,
        leaseToken: 'lease-a',
      }),
    contract.InvalidCancellationDispatchCommandError,
  );
});

test('rejects records that violate counter, lease, retry, or terminal state invariants', () => {
  for (const invalid of [
    pendingRecord({ version: 1 }),
    pendingRecord({ status: 'retry_wait', version: 2, dispatchCount: 1 }),
    pendingRecord({
      status: 'leased',
      version: 1,
      dispatchCount: 1,
      nextAttemptAtMs: undefined,
      leaseOwner: 'primary-a',
      leaseTokenDigest: TOKEN_DIGEST,
      leaseExpiresAtMs: 1_750_000_000_200,
      lastResult: 'already_exited',
    }),
    pendingRecord({
      status: 'dispatched',
      version: 2,
      dispatchCount: 1,
      nextAttemptAtMs: undefined,
      lastResult: 'identity_mismatch',
    }),
    pendingRecord({
      status: 'blocked',
      version: 2,
      dispatchCount: 1,
      nextAttemptAtMs: undefined,
      lastResult: 'dispatch_error',
    }),
    pendingRecord({ version: 0, dispatchCount: 1 }),
  ]) {
    assert.throws(
      () => contract.normalizeCancellationDispatchRecord(invalid),
      contract.InvalidCancellationDispatchCommandError,
    );
  }
});

test('classifies every result into one durable state and low-sensitive event', () => {
  for (const result of contract.CANCELLATION_DISPATCH_RESULTS) {
    const state = contract.cancellationDispatchResultState(result);
    if (contract.CANCELLATION_DISPATCH_RETRYABLE_RESULTS.includes(result)) {
      assert.deepEqual(state, {
        status: 'retry_wait',
        eventType: 'run.cancel_dispatch_failed',
      });
    } else if (
      contract.CANCELLATION_DISPATCH_BLOCKING_RESULTS.includes(result)
    ) {
      assert.deepEqual(state, {
        status: 'blocked',
        eventType: 'run.cancel_dispatch_blocked',
      });
    } else {
      assert.deepEqual(state, {
        status: 'dispatched',
        eventType: 'run.cancel_dispatched',
      });
    }
  }
});

test('publishes the profile-neutral contract only through its explicit subpath', () => {
  assert.equal(root.normalizeCancellationDispatchRecord, undefined);
  assert.equal(
    root.PostgresCancellationDispatchRepository,
    undefined,
  );
});
