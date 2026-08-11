require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidWorkerExecutionOfferRetentionPageError,
  WorkerExecutionOfferJournalRetentionService,
} = require('../../back/runtime/application/workerExecutionOfferJournalRetentionService');

const START = 1_761_000_000_000;
const RETENTION = 60_000;

function offerId(sequence) {
  return sequence.toString(16).padStart(64, '0');
}

function record(sequence, state, settledAtMs = START) {
  return {
    revision: sequence,
    state,
    updatedAtMs: settledAtMs,
    ...(state === 'completion_acknowledged'
      ? { completionAcknowledgedAtMs: settledAtMs }
      : {}),
    offer: {
      offerId: offerId(sequence),
      candidate: { attemptId: `attempt-${sequence}` },
    },
  };
}

class MemoryJournal {
  constructor(records) {
    this.records = new Map(
      records.map((value) => [value.offer.offerId, { ...value }]),
    );
    this.removeCalls = [];
    this.removeFailure = new Set();
  }

  async list({ afterOfferId, limit }) {
    const values = [...this.records.values()]
      .sort((left, right) =>
        left.offer.offerId.localeCompare(right.offer.offerId),
      )
      .filter(
        (value) =>
          afterOfferId === undefined || value.offer.offerId > afterOfferId,
      );
    const records = values.slice(0, limit);
    return {
      records,
      ...(values.length > records.length
        ? { nextAfterOfferId: records[records.length - 1].offer.offerId }
        : {}),
    };
  }

  async remove(id, expectedRevision) {
    this.removeCalls.push([id, expectedRevision]);
    if (this.removeFailure.has(id)) throw new Error('revision changed');
    const current = this.records.get(id);
    if (!current) return false;
    assert.equal(current.revision, expectedRevision);
    this.records.delete(id);
    return true;
  }
}

function service(records, options = {}) {
  const journal = options.journal || new MemoryJournal(records);
  const receiptCalls = [];
  const receipts = {
    async remove(attemptId) {
      receiptCalls.push(attemptId);
      if (options.receiptFailure === attemptId) {
        throw new Error('secret receipt path failure');
      }
      return true;
    },
  };
  return {
    journal,
    receiptCalls,
    retention: new WorkerExecutionOfferJournalRetentionService(
      journal,
      receipts,
      {
        completionRetentionMs: RETENTION,
        startFailureRetentionMs: RETENTION,
        pageSize: options.pageSize || 16,
        maximumRemovals: options.maximumRemovals || 8,
        clock: { now: () => options.now ?? START + 2 * RETENTION },
      },
    ),
  };
}

test('removes only due terminal records and cleans completion receipts first', async () => {
  const context = service([
    record(1, 'completion_acknowledged'),
    record(2, 'start_failure_acknowledged'),
    record(3, 'completion_acknowledged', START + 90_000),
    record(4, 'running_acknowledged'),
  ]);
  const result = await context.retention.sweep();
  assert.equal(result.status, 'complete');
  assert.equal(result.recordsScanned, 4);
  assert.equal(result.eligibleRecords, 2);
  assert.equal(result.recordsRemoved, 2);
  assert.equal(result.retainedRecords, 2);
  assert.deepEqual(context.receiptCalls, ['attempt-1']);
  assert.deepEqual(context.journal.removeCalls, [
    [offerId(1), 1],
    [offerId(2), 2],
  ]);
  assert.deepEqual(
    [...context.journal.records.keys()],
    [offerId(3), offerId(4)],
  );
});

test('retains terminal journals when receipt cleanup or revision fencing fails', async () => {
  const journal = new MemoryJournal([
    record(1, 'completion_acknowledged'),
    record(2, 'start_failure_acknowledged'),
  ]);
  journal.removeFailure.add(offerId(2));
  const context = service([], {
    journal,
    receiptFailure: 'attempt-1',
  });
  const result = await context.retention.sweep();
  assert.equal(result.failedRecords, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.outcome),
    ['receipt_cleanup_failed', 'journal_remove_failed'],
  );
  assert.equal(journal.records.size, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret receipt path failure/);
});

test('stops before exceeding write budget and resumes from a stable cursor', async () => {
  const context = service(
    [
      record(1, 'completion_acknowledged'),
      record(2, 'completion_acknowledged'),
      record(3, 'completion_acknowledged'),
    ],
    { maximumRemovals: 1 },
  );
  const first = await context.retention.sweep();
  assert.equal(first.status, 'removal_budget_exhausted');
  assert.equal(first.recordsRemoved, 1);
  assert.equal(first.nextAfterOfferId, offerId(1));
  const second = await context.retention.sweep({
    afterOfferId: first.nextAfterOfferId,
  });
  assert.equal(second.status, 'removal_budget_exhausted');
  assert.equal(second.nextAfterOfferId, offerId(2));
  assert.equal(context.journal.records.size, 1);
});

test('rejects malformed pages, clocks, and unbounded retention settings', async () => {
  const malformed = new WorkerExecutionOfferJournalRetentionService(
    {
      async list() {
        return {
          records: [record(2, 'completion_acknowledged')],
          nextAfterOfferId: offerId(1),
        };
      },
      async remove() {
        return true;
      },
    },
    {
      async remove() {
        return true;
      },
    },
    {
      completionRetentionMs: RETENTION,
      startFailureRetentionMs: RETENTION,
      pageSize: 1,
      maximumRemovals: 1,
      clock: { now: () => START },
    },
  );
  await assert.rejects(
    malformed.sweep(),
    InvalidWorkerExecutionOfferRetentionPageError,
  );
  await assert.rejects(
    service([], { now: -1 }).retention.sweep(),
    /clock returned an invalid time/,
  );
  assert.throws(
    () =>
      new WorkerExecutionOfferJournalRetentionService(
        { async list() {}, async remove() {} },
        { async remove() {} },
        {
          completionRetentionMs: 1,
          startFailureRetentionMs: RETENTION,
        },
      ),
    /completionRetentionMs must be between/,
  );
});
