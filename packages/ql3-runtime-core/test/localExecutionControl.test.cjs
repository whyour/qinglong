const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_LOCAL_EXECUTION_CONTROL_PAGE,
  assertLocalExecutionControlLimit,
  normalizeLocalActiveExecutionCandidate,
  normalizeLocalActiveExecutionCursor,
  normalizeLocalExecutionControlCandidate,
  normalizeLocalExecutionControlCursor,
} = require('../dist/local-runtime/localExecutionControl');

test('normalizes bounded deadline, cancellation and active candidates', () => {
  assert.deepEqual(
    normalizeLocalExecutionControlCandidate({
      kind: 'deadline',
      runId: 'run-1',
      attemptId: 'attempt-1',
      dueAtMs: 10,
    }),
    {
      kind: 'deadline',
      runId: 'run-1',
      attemptId: 'attempt-1',
      dueAtMs: 10,
    },
  );
  assert.equal(
    normalizeLocalExecutionControlCandidate({
      kind: 'cancellation',
      runId: 'run-1',
      attemptId: 'attempt-1',
      dueAtMs: 11,
      cancelReason: 'shutdown',
    }).cancelReason,
    'shutdown',
  );
  assert.equal(
    normalizeLocalActiveExecutionCandidate({
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptCreatedAtMs: 1,
    }).attemptCreatedAtMs,
    1,
  );
  assert.equal(
    normalizeLocalExecutionControlCursor({
      dueAtMs: 10,
      kind: 'deadline',
      attemptId: 'attempt-1',
    }).attemptId,
    'attempt-1',
  );
  assert.equal(
    normalizeLocalActiveExecutionCursor({
      attemptCreatedAtMs: 1,
      attemptId: 'attempt-1',
    }).attemptId,
    'attempt-1',
  );
});

test('rejects widened candidates and unbounded control pages', () => {
  assert.throws(
    () =>
      normalizeLocalExecutionControlCandidate({
        kind: 'deadline',
        runId: 'run-1',
        attemptId: 'attempt-1',
        dueAtMs: 1,
        cancelReason: 'timeout',
      }),
    /shape/,
  );
  assert.throws(
    () =>
      normalizeLocalExecutionControlCandidate({
        kind: 'cancellation',
        runId: 'run-1',
        attemptId: 'attempt-1',
        dueAtMs: 1,
        cancelReason: 'invalid',
      }),
    /reason/,
  );
  assert.doesNotThrow(() =>
    assertLocalExecutionControlLimit(MAX_LOCAL_EXECUTION_CONTROL_PAGE),
  );
  assert.throws(
    () => assertLocalExecutionControlLimit(MAX_LOCAL_EXECUTION_CONTROL_PAGE + 1),
    /limit/,
  );
});
