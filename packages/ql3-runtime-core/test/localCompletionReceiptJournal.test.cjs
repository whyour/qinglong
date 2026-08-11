const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE,
  assertLocalCompletionReceiptId,
  assertLocalCompletionReceiptJournalCursor,
  assertLocalCompletionReceiptJournalLimit,
  assertLocalCompletionReceiptTimestamp,
} = require('../dist/local-runtime/localCompletionReceiptJournal');

const ATTEMPT_ID = '019f70c0-0000-7000-8000-000000000001';

test('accepts bounded portable receipt identities without path syntax', () => {
  assert.doesNotThrow(() =>
    assertLocalCompletionReceiptId(ATTEMPT_ID, 'attemptId'),
  );
  assert.doesNotThrow(() =>
    assertLocalCompletionReceiptId(
      'wta:0123456789abcdef0123456789abcdef',
      'attemptId',
    ),
  );
  for (const value of [
    '',
    '../attempt-1',
    'attempt/1',
    'attempt\\1',
    'attempt 1',
    `attempt-${'a'.repeat(36)}`,
  ]) {
    assert.throws(
      () => assertLocalCompletionReceiptId(value, 'attemptId'),
      /bounded portable execution ID/,
    );
  }
});

test('bounds timestamps, cursors and page sizes', () => {
  assert.doesNotThrow(() => assertLocalCompletionReceiptTimestamp(0, 'time'));
  assert.doesNotThrow(() =>
    assertLocalCompletionReceiptJournalCursor({
      updatedAtMs: 1,
      attemptId: ATTEMPT_ID,
    }),
  );
  assert.doesNotThrow(() =>
    assertLocalCompletionReceiptJournalLimit(
      MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE,
    ),
  );
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertLocalCompletionReceiptTimestamp(value, 'time'),
      /non-negative safe integer/,
    );
  }
  for (const value of [0, 1.5, MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE + 1]) {
    assert.throws(
      () => assertLocalCompletionReceiptJournalLimit(value),
      /limit must be between/,
    );
  }
});
