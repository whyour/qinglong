const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  StepRunFenceConflictError,
  StepRunMutationConflictError,
  StepRunStateConflictError,
  createStepRunMutation,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqliteStepRunRepository,
} = require('../dist/run/stepRunRepository');

const DEFINITION_DIGEST = 'a'.repeat(64);

async function harness() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    authority,
    repository: new LocalSqliteStepRunRepository(authority),
    close: () => authority.close(),
  };
}

function insertRun(client, id, version = 0, eventSequence = 0) {
  client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version,
         event_sequence, priority, created_at_ms
       ) VALUES (?, 'project-001', 'task-001', 'revision-001', 'manual',
                 'manual', 'runtime', 'running', ?, ?, 0, 1)`,
    )
    .run(id, version, eventSequence);
}

function createMutation(options = {}) {
  const {
    id = 'step-run-001',
    runId = 'run-001',
    stepKey = 'workflow.fetch',
    mutationId = 'step-create-001',
    eventId = 'event-step-001',
    dedupeKey = `step-create:${id}`,
    expectedRunVersion = 0,
    expectedRunEventSequence = 0,
    parentStepRunId,
    initialStatus = 'pending',
    createdAtMs = 1_000,
  } = options;
  return createStepRunMutation(
    {
      id,
      runId,
      ...(parentStepRunId === undefined ? {} : { parentStepRunId }),
      stepKey,
      kind: 'tool',
      definitionRef: 'tool:demo.compare@1.0.0',
      definitionDigest: DEFINITION_DIGEST,
      required: true,
      initialStatus,
      inputRef: `artifact:${id}:input`,
      mutationId,
      createdAtMs,
    },
    {
      expectedRunVersion,
      expectedRunEventSequence,
      eventId,
      dedupeKey,
      actor: { type: 'agent', id: 'agent-001' },
    },
  );
}

function transitionMutation(current, to, runVersion, eventSequence, options = {}) {
  const mutationId =
    options.mutationId ?? `step-${to}-${current.version + 1}`;
  return transitionStepRunMutation(
    current,
    {
      expectedVersion: current.version,
      expectedDigest: current.stepRunDigest,
      mutationId,
      to,
      atMs: options.atMs ?? current.updatedAtMs + 100,
      ...(options.approvalRequestId === undefined
        ? {}
        : { approvalRequestId: options.approvalRequestId }),
      ...(options.outputRef === undefined
        ? {}
        : { outputRef: options.outputRef }),
      ...(options.resultCode === undefined
        ? {}
        : { resultCode: options.resultCode }),
      ...(options.errorSummary === undefined
        ? {}
        : { errorSummary: options.errorSummary }),
    },
    {
      expectedRunVersion: runVersion,
      expectedRunEventSequence: eventSequence,
      eventId: options.eventId ?? `event-${to}-${current.version + 1}`,
      dedupeKey:
        options.dedupeKey ?? `step-${to}:${current.id}:${current.version + 1}`,
      actor: { type: 'agent', id: 'agent-001' },
    },
  );
}

test('atomically creates, transitions and replays historical StepRun mutations', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001');

  const created = createMutation();
  assert.deepEqual(await value.repository.apply(created), {
    status: 'applied',
    stepRun: created.stepRun,
    runVersion: 1,
    runEventSequence: 1,
  });
  assert.deepEqual(await value.repository.findById(created.stepRun.id), created.stepRun);
  assert.deepEqual(
    await value.repository.findByRunAndStepKey('run-001', 'workflow.fetch'),
    created.stepRun,
  );
  assert.deepEqual(await value.repository.apply(created), {
    status: 'existing',
    stepRun: created.stepRun,
    runVersion: 1,
    runEventSequence: 1,
  });

  const ready = transitionMutation(created.stepRun, 'ready', 1, 1);
  assert.deepEqual(await value.repository.apply(ready), {
    status: 'applied',
    stepRun: ready.stepRun,
    runVersion: 2,
    runEventSequence: 2,
  });
  assert.deepEqual(await value.repository.findById(created.stepRun.id), ready.stepRun);

  assert.deepEqual(await value.repository.apply(created), {
    status: 'existing',
    stepRun: created.stepRun,
    runVersion: 1,
    runEventSequence: 1,
  });
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT version, event_sequence AS "eventSequence"
           FROM "Runs" WHERE id = 'run-001'`,
        )
        .get(),
    },
    { version: 2, eventSequence: 2 },
  );
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT COUNT(*) AS events,
                  COUNT(DISTINCT dedupe_key) AS dedupeKeys
           FROM "RunEvents" WHERE run_id = 'run-001'`,
        )
        .get(),
    },
    { events: 2, dedupeKeys: 2 },
  );
  assert.equal(
    value.client
      .prepare('SELECT COUNT(*) AS count FROM "StepRunMutations"')
      .get().count,
    2,
  );
});

test('rolls the whole aggregate back on a stale Run fence', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001', 3, 4);

  const stale = createMutation({
    expectedRunVersion: 2,
    expectedRunEventSequence: 4,
  });
  await assert.rejects(
    value.repository.apply(stale),
    StepRunFenceConflictError,
  );
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM "StepRuns") AS stepRuns,
             (SELECT COUNT(*) FROM "RunEvents") AS events,
             (SELECT COUNT(*) FROM "StepRunMutations") AS mutations,
             (SELECT version FROM "Runs" WHERE id = 'run-001') AS runVersion`,
        )
        .get(),
    },
    { stepRuns: 0, events: 0, mutations: 0, runVersion: 3 },
  );
});

test('rejects StepRun mutation after the Run aggregate is terminal', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001');
  value.client
    .prepare(`UPDATE "Runs" SET status = 'succeeded' WHERE id = 'run-001'`)
    .run();
  await assert.rejects(
    value.repository.apply(createMutation()),
    StepRunStateConflictError,
  );
  assert.equal(
    value.client
      .prepare('SELECT COUNT(*) AS count FROM "StepRuns"')
      .get().count,
    0,
  );
});

test('rejects step-key collisions, missing parents and mutation identity reuse', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001');
  const first = createMutation();
  await value.repository.apply(first);

  const collision = createMutation({
    id: 'step-run-002',
    stepKey: first.stepRun.stepKey,
    mutationId: 'step-create-002',
    eventId: 'event-step-002',
    expectedRunVersion: 1,
    expectedRunEventSequence: 1,
  });
  await assert.rejects(
    value.repository.apply(collision),
    StepRunStateConflictError,
  );

  const missingParent = createMutation({
    id: 'step-run-003',
    stepKey: 'workflow.child',
    parentStepRunId: 'step-run-missing',
    mutationId: 'step-create-003',
    eventId: 'event-step-003',
    expectedRunVersion: 1,
    expectedRunEventSequence: 1,
  });
  await assert.rejects(
    value.repository.apply(missingParent),
    StepRunStateConflictError,
  );

  const reused = createMutation({
    id: 'step-run-reused',
    stepKey: 'workflow.reused',
    mutationId: first.mutationId,
    eventId: 'event-step-reused',
    dedupeKey: 'step-create:step-run-reused',
    expectedRunVersion: 1,
    expectedRunEventSequence: 1,
  });
  await assert.rejects(
    value.repository.apply(reused),
    StepRunMutationConflictError,
  );
  assert.equal(
    value.client
      .prepare('SELECT COUNT(*) AS count FROM "StepRuns"')
      .get().count,
    1,
  );
});

test('lists StepRuns with stable keyset pagination', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001');
  let runVersion = 0;
  let eventSequence = 0;
  for (const [index, stepKey] of ['workflow.c', 'workflow.a', 'workflow.b'].entries()) {
    const mutation = createMutation({
      id: `step-run-00${index + 1}`,
      stepKey,
      mutationId: `step-create-00${index + 1}`,
      eventId: `event-step-00${index + 1}`,
      dedupeKey: `step-create:00${index + 1}`,
      expectedRunVersion: runVersion,
      expectedRunEventSequence: eventSequence,
      createdAtMs: 1_000 + index,
    });
    await value.repository.apply(mutation);
    runVersion += 1;
    eventSequence += 1;
  }

  const first = await value.repository.listByRun({
    runId: 'run-001',
    limit: 2,
  });
  assert.deepEqual(first.stepRuns.map((item) => item.stepKey), [
    'workflow.a',
    'workflow.b',
  ]);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.next, {
    stepKey: 'workflow.b',
    id: 'step-run-003',
  });
  const second = await value.repository.listByRun({
    runId: 'run-001',
    limit: 2,
    after: first.next,
  });
  assert.deepEqual(second.stepRuns.map((item) => item.stepKey), [
    'workflow.c',
  ]);
  assert.equal(second.truncated, false);
  assert.equal(second.next, undefined);
});

test('reviewed guards bind Attempt and Event StepRun references to the same Run', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001');
  insertRun(value.client, 'run-002');
  const created = createMutation();
  await value.repository.apply(created);

  assert.throws(
    () =>
      value.client
        .prepare(
          `INSERT INTO "RunAttempts" (
             id, run_id, step_run_id, attempt, status, executor_type,
             callback_sequence, created_at_ms
           ) VALUES (
             'attempt-cross-run', 'run-002', 'step-run-001', 1, 'claimed',
             'local_process', 0, 1
           )`,
        )
        .run(),
    /StepRun reference mismatch/,
  );
  assert.throws(
    () =>
      value.client
        .prepare(
          `INSERT INTO "RunEvents" (
             id, run_id, sequence, type, dedupe_key, actor_type, step_run_id,
             payload, created_at_ms
           ) VALUES (
             'event-cross-run', 'run-002', 1, 'step.test',
             'event-cross-run', 'system', 'step-run-001', '{}', 1
           )`,
        )
        .run(),
    /StepRun reference mismatch/,
  );
});

test('binds every mutable StepRun mirror column to its digested JSON record', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  insertRun(value.client, 'run-001');
  const created = createMutation();
  await value.repository.apply(created);

  assert.throws(
    () =>
      value.client
        .prepare(
          `UPDATE "StepRuns"
           SET definition_ref = 'tool:tampered@1.0.0'
           WHERE id = 'step-run-001'`,
        )
        .run(),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    await value.repository.findById('step-run-001'),
    created.stepRun,
  );
});

test('publishes the repository only through the explicit step-run subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/step-run');
  assert.equal(
    entrypoint.LocalSqliteStepRunRepository,
    LocalSqliteStepRunRepository,
  );
  assert.equal(require('../dist').LocalSqliteStepRunRepository, undefined);
});
