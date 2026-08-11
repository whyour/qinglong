require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  RunEventPayloadTooLargeError,
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
} = require('../../back/runtime/domain/repositoryErrors');
const {
  MAX_RUN_EVENT_PAYLOAD_BYTES,
} = require('../../back/runtime/ports/runRepository');
const {
  PostgresRunRepository,
  PostgresRunTransaction,
} = require('../../back/runtime/adapters/postgresql/runRepository');

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

const ATTEMPT = Object.freeze({
  id: '019f70b0-0000-7000-8000-000000000002',
  runId: RUN.id,
  attempt: 1,
  status: 'claimed',
  executorType: 'remote_worker',
  callbackSequence: 0,
  createdAtMs: 1_750_000_000_001,
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

const RETRY_POLICY = Object.freeze({
  runId: RUN.id,
  maxAttempts: 3,
  retryOnLost: true,
  safety: 'idempotent',
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  version: 0,
  createdAtMs: 1_750_000_000_002,
  updatedAtMs: 1_750_000_000_002,
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
    client,
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

test('orders one bounded PostgreSQL transaction and releases its client', async () => {
  const harness = clientHarness();
  const repository = new PostgresRunRepository(harness.pool);
  const result = await repository.transaction(async () => 'committed');
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
  assert.deepEqual(
    harness.queries.slice(2, 5).map(({ values }) => values[0]),
    ['5000ms', '1000ms', '10000ms'],
  );
  assert.equal(harness.released(), 1);
});

test('rolls back work errors unchanged and maps commit serialization failure', async () => {
  const workHarness = clientHarness();
  const workRepository = new PostgresRunRepository(workHarness.pool);
  const failure = new Error('work failed');
  await assert.rejects(
    workRepository.transaction(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(workHarness.queries.at(-1).text, 'ROLLBACK');
  assert.equal(workHarness.released(), 1);

  const commitHarness = clientHarness(async (text) => {
    if (text === 'COMMIT') throw driverError('40001');
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    new PostgresRunRepository(commitHarness.pool).transaction(async () => 1),
    RunRepositoryBusyError,
  );
  assert.equal(commitHarness.queries.at(-1).text, 'ROLLBACK');
  assert.equal(commitHarness.released(), 1);
});

test('normalizes bigint rows and rejects corrupt enum data', async () => {
  const runRow = {
    ...RUN,
    createdAtMs: String(RUN.createdAtMs),
    scheduledForMs: '1750000000100',
    taskSnapshotRef: null,
    legacyCronId: null,
    parentRunId: null,
    retryOfRunId: null,
    triggerId: null,
    requestId: null,
    queuedAtMs: null,
    startedAtMs: null,
    finishedAtMs: null,
    cancelRequestedAtMs: null,
    cancelReason: null,
    inputRef: null,
    outputRef: null,
    errorCode: null,
    errorSummary: null,
  };
  const harness = clientHarness(async (text) => {
    if (text.includes('FROM "ql3"."runs"')) {
      return { rows: [runRow], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new PostgresRunRepository(harness.pool);
  assert.deepEqual(await repository.findRunById(RUN.id), {
    ...RUN,
    scheduledForMs: 1_750_000_000_100,
  });

  runRow.status = 'invented';
  await assert.rejects(
    repository.findRunById(RUN.id),
    RunRepositoryConstraintError,
  );
});

test('writes every aggregate shape and uses exact CAS predicates', async () => {
  const queries = [];
  const transaction = new PostgresRunTransaction({
    async query(text, values) {
      queries.push({ text, values });
      return text.startsWith('UPDATE')
        ? { rows: [{ id: values[0] }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    },
  });
  await transaction.insertRun(RUN);
  await transaction.insertAttempt(ATTEMPT);
  await transaction.insertRetryPolicy(RETRY_POLICY);
  await transaction.appendEvent(EVENT);
  assert.equal(
    await transaction.compareAndSetRun(
      { ...RUN, status: 'queued', version: 1 },
      0,
    ),
    true,
  );
  assert.equal(
    await transaction.compareAndSetAttempt(
      { ...ATTEMPT, status: 'starting', callbackSequence: 1 },
      { status: 'claimed', callbackSequence: 0 },
    ),
    true,
  );
  assert.equal(
    await transaction.compareAndSetRetryPolicy(
      { ...RETRY_POLICY, version: 1, updatedAtMs: 1_750_000_000_003 },
      0,
    ),
    true,
  );

  const updates = queries.filter(({ text }) => text.startsWith('UPDATE'));
  assert.equal(updates.length, 3);
  assert.match(updates[0].text, /"version" = \$32/);
  assert.equal(updates[0].values.length, 32);
  assert.match(updates[1].text, /"status" = \$22/);
  assert.match(updates[1].text, /"callback_sequence" = \$23/);
  assert.equal(updates[1].values.length, 23);
  assert.match(updates[2].text, /"version" = \$11/);
  assert.equal(updates[2].values.length, 11);
  for (const { text } of updates) assert.doesNotMatch(text, /\$\$/);
});

test('maps stable PostgreSQL constraints without leaking driver errors', async () => {
  const transactionFor = (error) =>
    new PostgresRunTransaction({
      async query() {
        throw error;
      },
    });
  await assert.rejects(
    transactionFor(
      driverError('23505', 'ql3_runs_project_idempotency_uidx'),
    ).insertRun(RUN),
    DuplicateIdempotencyKeyError,
  );
  await assert.rejects(
    transactionFor(
      driverError('23505', 'ql3_run_attempts_run_attempt_uidx'),
    ).insertAttempt(ATTEMPT),
    DuplicateRunAttemptError,
  );
  await assert.rejects(
    transactionFor(
      driverError('23505', 'ql3_run_events_run_dedupe_uidx'),
    ).appendEvent(EVENT),
    DuplicateRunEventError,
  );
  await assert.rejects(
    transactionFor(driverError('23514')).insertRetryPolicy(RETRY_POLICY),
    RunRepositoryConstraintError,
  );
  await assert.rejects(
    transactionFor(driverError('55P03')).compareAndSetRun(
      { ...RUN, version: 1 },
      0,
    ),
    RunRepositoryBusyError,
  );
});

test('rejects non-incrementing CAS and oversized event payloads before SQL', async () => {
  let calls = 0;
  const transaction = new PostgresRunTransaction({
    async query() {
      calls += 1;
      return { rows: [], rowCount: 0 };
    },
  });
  await assert.rejects(
    transaction.compareAndSetRun({ ...RUN, version: 2 }, 0),
    RunRepositoryConstraintError,
  );
  await assert.rejects(
    transaction.compareAndSetRetryPolicy(
      { ...RETRY_POLICY, version: 2, updatedAtMs: 1_750_000_000_003 },
      0,
    ),
    RunRepositoryConstraintError,
  );
  await assert.rejects(
    transaction.appendEvent({
      ...EVENT,
      payload: { value: 'x'.repeat(MAX_RUN_EVENT_PAYLOAD_BYTES) },
    }),
    RunEventPayloadTooLargeError,
  );
  assert.equal(calls, 0);
});
