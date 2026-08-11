require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidWorkerExecutionOfferStartupRecoveryInputError,
  WorkerExecutionOfferStartupRecoveryAuditIncompleteError,
  WorkerExecutionOfferStartupRecoverySupervisor,
} = require('../../back/runtime/application/workerExecutionOfferStartupRecoverySupervisor');

function entry(sequence, category) {
  return {
    offerId: `offer-${sequence}`,
    attemptId: `attempt-${sequence}`,
    state:
      category === 'settled_completion' ? 'completion_acknowledged' : 'started',
    category,
  };
}

function audit(entries, status = 'reconciliation_required') {
  return {
    status,
    observedAtMs: 1_760_900_000_000,
    pagesScanned: 1,
    recordsScanned: entries.length,
    counts: {},
    entries,
  };
}

test('recovers actionable startup entries serially and skips redelivery states', async () => {
  const calls = [];
  const supervisor = new WorkerExecutionOfferStartupRecoverySupervisor({
    async recover(offerId) {
      calls.push(offerId);
      return {
        offerId,
        status:
          offerId === 'offer-1'
            ? 'completion_acknowledged'
            : 'running_acknowledged',
        ...(offerId === 'offer-1' ? { receiptCleanup: 'removed' } : {}),
      };
    },
  });
  const result = await supervisor.recover(
    audit([
      entry(1, 'launch_reconciliation_required'),
      entry(2, 'redelivery_required'),
      entry(3, 'execution_reconciliation_required'),
    ]),
  );
  assert.equal(result.status, 'recovered');
  assert.deepEqual(calls, ['offer-1', 'offer-3']);
  assert.deepEqual(
    result.entries.map((value) => [
      value.offerId,
      value.actionStatus,
      value.receiptCleanup,
    ]),
    [
      ['offer-1', 'completion_acknowledged', 'removed'],
      ['offer-3', 'running_acknowledged', undefined],
    ],
  );
});

test('isolates one action failure but keeps startup reconciliation unresolved', async () => {
  const calls = [];
  const supervisor = new WorkerExecutionOfferStartupRecoverySupervisor({
    async recover(offerId) {
      calls.push(offerId);
      if (offerId === 'offer-1') {
        throw new Error('secret transport failure');
      }
      return { offerId, status: 'deferred' };
    },
  });
  const result = await supervisor.recover(
    audit([
      entry(1, 'launch_reconciliation_required'),
      entry(2, 'execution_reconciliation_required'),
    ]),
  );
  assert.equal(result.status, 'reconciliation_required');
  assert.deepEqual(calls, ['offer-1', 'offer-2']);
  assert.deepEqual(
    result.entries.map((value) => [value.outcome, value.actionStatus]),
    [
      ['failed', undefined],
      ['applied', 'deferred'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /secret transport failure/);
});

test('fails closed before side effects when either scan or action budget is incomplete', async () => {
  const calls = [];
  const supervisor = new WorkerExecutionOfferStartupRecoverySupervisor(
    {
      async recover(offerId) {
        calls.push(offerId);
        return { offerId, status: 'already_completed' };
      },
    },
    { maximumActions: 1 },
  );
  await assert.rejects(
    supervisor.recover(audit([], 'scan_budget_exhausted')),
    WorkerExecutionOfferStartupRecoveryAuditIncompleteError,
  );
  const exhausted = await supervisor.recover(
    audit([
      entry(1, 'settled_completion'),
      entry(2, 'execution_reconciliation_required'),
    ]),
  );
  assert.deepEqual(exhausted, {
    status: 'action_budget_exhausted',
    actionsPlanned: 2,
    actionsAttempted: 0,
    entries: [],
  });
  assert.deepEqual(calls, []);
});

test('rejects malformed audit boundaries and unbounded settings', async () => {
  const supervisor = new WorkerExecutionOfferStartupRecoverySupervisor({
    async recover(offerId) {
      return { offerId, status: 'not_found' };
    },
  });
  const duplicate = entry(1, 'settled_completion');
  await assert.rejects(
    supervisor.recover(audit([duplicate, duplicate])),
    InvalidWorkerExecutionOfferStartupRecoveryInputError,
  );
  await assert.rejects(
    supervisor.recover({ ...audit([duplicate]), recordsScanned: 2 }),
    InvalidWorkerExecutionOfferStartupRecoveryInputError,
  );
  assert.throws(
    () =>
      new WorkerExecutionOfferStartupRecoverySupervisor(
        { async recover() {} },
        { maximumActions: 1025 },
      ),
    /maximumActions must be between/,
  );
});
