'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRunCancellationConvergenceUnavailableError,
} = require('@qinglong/runtime-core/cluster-run-cancellation-convergence');
const {
  PostgresClusterRunCancellationConvergenceRepository,
} = require('../dist/entrypoints/runtime');

function row(overrides = {}) {
  return {
    observedAtMs: '1750000000100',
    runId: 'run-1',
    runStatus: 'queued',
    runVersion: 3,
    eventSequence: 4,
    runCreatedAtMs: '1750000000000',
    runQueuedAtMs: '1750000000010',
    runStartedAtMs: null,
    cancelRequestedAtMs: '1750000000050',
    cancelReason: 'user',
    attemptId: 'attempt-1',
    attemptStatus: 'claimed',
    stepRunId: null,
    attemptNumber: 1,
    attemptCreatedAtMs: '1750000000010',
    attemptStartedAtMs: null,
    attemptFinishedAtMs: null,
    leaseStatus: null,
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  let runUpdates = 0;
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (
        normalized === 'BEGIN' || normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' || normalized.startsWith('SELECT set_config')
      ) return { rows: [], rowCount: 0 };
      if (normalized.startsWith('WITH observation AS MATERIALIZED')) {
        return { rows: options.rows ?? [row()], rowCount: options.rows?.length ?? 1 };
      }
      if (normalized.startsWith('UPDATE "ql3"."run_attempts"')) {
        return { rows: [], rowCount: options.attemptRowCount ?? 1 };
      }
      if (normalized.startsWith('UPDATE "ql3"."runs"')) {
        runUpdates += 1;
        return {
          rows: [],
          rowCount: options.failRunUpdate === runUpdates ? 0 : 1,
        };
      }
      if (normalized.startsWith('INSERT INTO "ql3"."run_events"')) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT id AS "runId" FROM "ql3"."runs"')) {
        return {
          rows: options.workflowRows ?? [],
          rowCount: options.workflowRows?.length ?? 0,
        };
      }
      if (normalized.startsWith('SELECT EXISTS')) {
        return { rows: [{ hasMore: options.hasMore ?? false }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    repository: new PostgresClusterRunCancellationConvergenceRepository({
      async connect() { return client; },
    }),
    calls,
  };
}

test('atomically settles queued claimed and lost terminal-attempt Runs', async () => {
  const { repository, calls } = fixture({
    rows: [
      row(),
      row({
        runId: 'run-2',
        runStatus: 'lost',
        runVersion: 7,
        eventSequence: 8,
        cancelReason: 'policy',
        attemptId: 'attempt-2',
        attemptStatus: 'lost',
        attemptFinishedAtMs: '1750000000020',
      }),
    ],
  });
  assert.deepEqual(await repository.convergePage({
    limit: 2,
  }), {
    scanned: 2,
    settledRuns: 2,
    settledAttempts: 1,
    blocked: 0,
    hasMore: false,
  });
  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'));
  assert.equal(attemptUpdate.params[1], 'cancelled');
  const runUpdates = calls.filter(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'));
  assert.equal(runUpdates.length, 2);
  assert.equal(runUpdates[0].params[5], 5);
  assert.equal(runUpdates[0].params[6], 6);
  assert.equal(runUpdates[1].params[5], 8);
  assert.equal(runUpdates[1].params[6], 9);
  const events = calls.filter(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"'));
  assert.equal(events.length, 3);
  assert.match(events[0].params[0], /^qca-[0-9a-f]{32}$/);
  assert.match(events[1].params[0], /^qcr-[0-9a-f]{32}$/);
  assert.match(events[2].params[0], /^qcr-[0-9a-f]{32}$/);
  assert.equal(new Set(events.map(({ params }) => params[0])).size, 3);
  const candidate = calls.find(({ sql }) =>
    sql.startsWith('WITH observation AS MATERIALIZED'));
  assert.match(
    candidate.sql,
    /run\.trigger_type <> 'plugin_package_workflow'/,
  );
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), true);
});

test('maps timeout intent to timed_out and preserves database-scale time', async () => {
  const { repository, calls } = fixture({
    rows: [row({
      attemptId: null,
      attemptStatus: null,
      attemptNumber: null,
      attemptCreatedAtMs: null,
      cancelReason: 'timeout',
    })],
  });
  assert.equal((await repository.convergePage({
    limit: 1,
  })).settledRuns, 1);
  const update = calls.find(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"'));
  assert.equal(update.params[1], 'timed_out');
  assert.equal(update.params[2], 1_750_000_000_100);
  assert.equal(update.params[3], 'EXECUTION_TIMED_OUT');
});

test('does not forge a terminal state for an execution that crossed start', async () => {
  const { repository, calls } = fixture({
    rows: [row({
      runStatus: 'waiting_approval',
      attemptStatus: 'running',
      leaseStatus: 'leased',
    })],
    hasMore: true,
  });
  assert.deepEqual(await repository.convergePage({
    limit: 1,
  }), {
    scanned: 1,
    settledRuns: 0,
    settledAttempts: 0,
    blocked: 1,
    hasMore: true,
  });
  assert.equal(calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
});

test('rolls back the whole page when a Run fence changes', async () => {
  const { repository, calls } = fixture({ failRunUpdate: 1 });
  await assert.rejects(
    repository.convergePage({ limit: 1 }),
    ClusterRunCancellationConvergenceUnavailableError,
  );
  assert.equal(calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
});
