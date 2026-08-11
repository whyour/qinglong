'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresClusterRuntimeRecoverySource,
} = require('../dist/entrypoints/runtime');

function source(rows, calls = []) {
  return new PostgresClusterRuntimeRecoverySource({
    async query(text, values) {
      calls.push({ text, values });
      return { rows };
    },
  });
}

test('returns only one bounded page of active expired Attempts', async () => {
  const calls = [];
  const recovery = source(
    [
      {
        observedAtMs: '1000',
        attemptId: 'attempt-1',
        runId: 'run-1',
        status: 'starting',
        createdAtMs: '100',
      },
      {
        observedAtMs: '1000',
        attemptId: 'attempt-2',
        runId: 'run-2',
        status: 'running',
        createdAtMs: '200',
      },
      {
        observedAtMs: '1000',
        attemptId: 'attempt-3',
        runId: 'run-3',
        status: 'claimed',
        createdAtMs: '300',
      },
    ],
    calls,
  );

  assert.deepEqual(await recovery.listOutstanding(2), {
    observedAtMs: 1000,
    candidates: [
      {
        kind: 'attempt',
        id: 'attempt-1',
        runId: 'run-1',
        status: 'starting',
        createdAtMs: 100,
      },
      {
        kind: 'attempt',
        id: 'attempt-2',
        runId: 'run-2',
        status: 'running',
        createdAtMs: 200,
      },
    ],
    hasMore: true,
  });
  assert.deepEqual(calls[0].values, [3]);
  assert.match(calls[0].text, /lease_expires_at_ms <= observation/);
  assert.match(calls[0].text, /run\.status IN \('dispatching', 'running', 'lost'\)/);
  assert.match(calls[0].text, /attempt\.worker_id IS NULL/);
  assert.doesNotMatch(calls[0].text, /status = 'created'/);
});

test('retains a database observation for an empty runtime page', async () => {
  const recovery = source([
    {
      observedAtMs: '1000',
      attemptId: null,
      runId: null,
      status: null,
      createdAtMs: null,
    },
  ]);
  assert.deepEqual(await recovery.listOutstanding(1), {
    observedAtMs: 1000,
    candidates: [],
    hasMore: false,
  });
});

test('rejects malformed rows and unbounded requests', async () => {
  let queries = 0;
  const recovery = new PostgresClusterRuntimeRecoverySource({
    async query() {
      queries += 1;
      return { rows: [] };
    },
  });
  await assert.rejects(recovery.listOutstanding(0), /between 1 and 128/);
  assert.equal(queries, 0);

  await assert.rejects(
    source([
      {
        observedAtMs: '1000',
        attemptId: 'attempt-1',
        runId: 'run-1',
        status: 'succeeded',
        createdAtMs: '100',
      },
    ]).listOutstanding(1),
    /Attempt status is invalid/,
  );
});
