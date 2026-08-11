const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DuplicateIdempotencyKeyError,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  RunEventPayloadTooLargeError,
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
} = require('@qinglong/runtime-core');
const { PostgresRunRepository, PostgresRunTransaction } = require('../dist');

const RUN = Object.freeze({
  id: '019f70b0-0000-7000-8000-000000000001',
  projectId: 'default',
  taskId: 'task-1',
  taskRevision: 'revision-1',
  taskName: 'test',
  triggerType: 'manual',
  executionOrigin: 'manual',
  executionOwner: 'runtime',
  triggeredBy: 'user:1',
  status: 'created',
  version: 0,
  eventSequence: 0,
  priority: 0,
  idempotencyKey: 'request-1',
  createdAtMs: 1_750_000_000_000,
});

const EVENT = Object.freeze({
  id: '019f70b0-0000-7000-8000-000000000003',
  runId: RUN.id,
  sequence: 1,
  type: 'run.created',
  dedupeKey: 'run.created',
  actorType: 'system',
  payload: Object.freeze({ source: 'postgres-test' }),
  createdAtMs: 1_750_000_000_002,
});

function driverError(code, constraint) {
  return Object.assign(new Error('driver failure'), { code, constraint });
}

function clientHarness(handler = async () => ({ rows: [], rowCount: 0 })) {
  const queries = [];
  let released = 0;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      return handler(text, values, queries.length);
    },
    release() {
      released += 1;
    },
  };
  return {
    queries,
    released: () => released,
    pool: {
      query: (...args) => client.query(...args),
      async connect() {
        return client;
      },
    },
  };
}

function databaseRunRow(overrides = {}) {
  return {
    ...RUN,
    createdAtMs: String(RUN.createdAtMs),
    taskSnapshotRef: null,
    legacyCronId: null,
    parentRunId: null,
    retryOfRunId: null,
    triggerId: null,
    requestId: null,
    scheduledForMs: null,
    queuedAtMs: null,
    startedAtMs: null,
    finishedAtMs: null,
    cancelRequestedAtMs: null,
    cancelReason: null,
    inputRef: null,
    outputRef: null,
    errorCode: null,
    errorSummary: null,
    ...overrides,
  };
}

test('orders one bounded PostgreSQL transaction and releases its client', async () => {
  const harness = clientHarness();
  const result = await new PostgresRunRepository(harness.pool).transaction(
    async () => 'committed',
  );
  assert.equal(result, 'committed');
  assert.deepEqual(
    harness.queries.map(({ text }) => text),
    [
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
      'COMMIT',
    ],
  );
  assert.equal(harness.released(), 1);
});

test('rolls back a serialization failure and exposes a stable domain error', async () => {
  const harness = clientHarness(async (text) => {
    if (text === 'COMMIT') throw driverError('40001');
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    new PostgresRunRepository(harness.pool).transaction(async () => 1),
    RunRepositoryBusyError,
  );
  assert.equal(harness.queries.at(-1).text, 'ROLLBACK');
  assert.equal(harness.released(), 1);
});

test('normalizes bigint rows and treats missing rows as null', async () => {
  const row = databaseRunRow({ scheduledForMs: '1750000000100' });
  const harness = clientHarness(async (text, values) => {
    if (!text.includes('FROM "ql3"."runs"')) {
      throw new Error(`unexpected query: ${text}`);
    }
    return values[0] === RUN.id
      ? { rows: [row], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  });
  const repository = new PostgresRunRepository(harness.pool);
  assert.deepEqual(await repository.findRunById(RUN.id), {
    ...RUN,
    scheduledForMs: 1_750_000_000_100,
  });
  assert.equal(await repository.findRunById('missing'), null);
});

test('lists one Project with the indexed descending Run keyset', async () => {
  const harness = clientHarness(async () => ({
    rows: [
      databaseRunRow({ id: 'run-c', createdAtMs: '20' }),
      databaseRunRow({ id: 'run-b', createdAtMs: '20' }),
    ],
    rowCount: 2,
  }));
  const repository = new PostgresRunRepository(harness.pool);
  const rows = await repository.listRunsByProject({
    projectId: 'default',
    limit: 2,
    after: { createdAtMs: 30, runId: 'run-z' },
  });
  assert.deepEqual(
    rows.map(({ id }) => id),
    ['run-c', 'run-b'],
  );
  assert.deepEqual(harness.queries[0].values, ['default', 'run-z', 30, 2]);
  assert.match(
    harness.queries[0].text,
    /ORDER BY "created_at_ms" DESC, "id" DESC\s+LIMIT \$4/u,
  );
  await assert.rejects(
    repository.listRunsByProject({ projectId: 'default', limit: 66 }),
    TypeError,
  );
});

test('rejects duplicate identity rows and corrupt enum data', async () => {
  const duplicate = clientHarness(async () => ({
    rows: [databaseRunRow(), databaseRunRow()],
    rowCount: 2,
  }));
  await assert.rejects(
    new PostgresRunRepository(duplicate.pool).findRunById(RUN.id),
    RunRepositoryConstraintError,
  );

  const corrupt = clientHarness(async () => ({
    rows: [databaseRunRow({ status: 'invented' })],
    rowCount: 1,
  }));
  await assert.rejects(
    new PostgresRunRepository(corrupt.pool).findRunById(RUN.id),
    RunRepositoryConstraintError,
  );
});

test('maps PostgreSQL constraint names without leaking driver errors', async () => {
  const transaction = new PostgresRunTransaction({
    async query() {
      throw driverError('23505', 'ql3_runs_project_idempotency_uidx');
    },
  });
  await assert.rejects(
    transaction.insertRun(RUN),
    DuplicateIdempotencyKeyError,
  );
});

test('rejects oversized event payloads before issuing SQL', async () => {
  let calls = 0;
  const transaction = new PostgresRunTransaction({
    async query() {
      calls += 1;
      return { rows: [], rowCount: 0 };
    },
  });
  await assert.rejects(
    transaction.appendEvent({
      ...EVENT,
      payload: { value: 'x'.repeat(MAX_RUN_EVENT_PAYLOAD_BYTES) },
    }),
    RunEventPayloadTooLargeError,
  );
  assert.equal(calls, 0);
});
