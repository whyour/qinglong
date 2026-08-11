const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

const RUN_1 = '019f70d0-0000-7000-8000-000000000001';
const RUN_2 = '019f70d0-0000-7000-8000-000000000002';
const ATTEMPT_1 = '019f70d0-0000-7000-8000-000000000011';
const ATTEMPT_2 = '019f70d0-0000-7000-8000-000000000012';

async function database(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-receipt-journal-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const opened = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => opened.close());
  return opened;
}

function run(id) {
  return {
    id,
    projectId: 'default',
    taskId: `task-${id}`,
    taskRevision: `revision-${id}`,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: 1,
  };
}

function attempt(id, runId, status = 'running', finishedAtMs) {
  return {
    id,
    runId,
    attempt: 1,
    status,
    executorType: 'local_process',
    callbackSequence: 0,
    createdAtMs: 1,
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
  };
}

test('registers one exact pre-spawn receipt barrier idempotently', async (t) => {
  const opened = await database(t);
  await opened.runRepository.transaction(async (transaction) => {
    await transaction.insertRun(run(RUN_1));
    await transaction.insertAttempt(attempt(ATTEMPT_1, RUN_1));
  });

  const command = { runId: RUN_1, attemptId: ATTEMPT_1, registeredAtMs: 10 };
  await opened.completionReceipts.register(command);
  await opened.completionReceipts.register(command);
  await assert.rejects(
    opened.completionReceipts.register({ ...command, registeredAtMs: 11 }),
    /registration conflicts/,
  );

  assert.deepEqual(
    await opened.completionReceipts.listCandidates({ observedAtMs: 20 }),
    {
      candidates: [
        {
          ...command,
          state: 'pending',
          updatedAtMs: 10,
          attemptStatus: 'running',
          executorType: 'local_process',
        },
      ],
      truncated: false,
      nextCursor: { updatedAtMs: 10, attemptId: ATTEMPT_1 },
    },
  );
});

test('pages deterministically and exposes quarantines only when purge is due', async (t) => {
  const opened = await database(t);
  await opened.runRepository.transaction(async (transaction) => {
    await transaction.insertRun(run(RUN_1));
    await transaction.insertAttempt(attempt(ATTEMPT_1, RUN_1, 'failed', 5));
    await transaction.insertRun(run(RUN_2));
    await transaction.insertAttempt(attempt(ATTEMPT_2, RUN_2));
  });
  await opened.completionReceipts.register({
    runId: RUN_1,
    attemptId: ATTEMPT_1,
    registeredAtMs: 10,
  });
  await opened.completionReceipts.register({
    runId: RUN_2,
    attemptId: ATTEMPT_2,
    registeredAtMs: 11,
  });
  await opened.completionReceipts.markQuarantined({
    attemptId: ATTEMPT_1,
    quarantineRef: `.quarantine/${ATTEMPT_1.slice(0, 2)}/${ATTEMPT_1}.json`,
    updatedAtMs: 20,
    purgeAfterMs: 30,
  });

  const beforePurge = await opened.completionReceipts.listCandidates({
    observedAtMs: 29,
    limit: 1,
  });
  assert.deepEqual(
    beforePurge.candidates.map(({ attemptId }) => attemptId),
    [ATTEMPT_2],
  );
  assert.equal(beforePurge.truncated, false);

  const due = await opened.completionReceipts.listCandidates({
    observedAtMs: 30,
    limit: 1,
  });
  assert.deepEqual(
    due.candidates.map(({ attemptId }) => attemptId),
    [ATTEMPT_2],
  );
  assert.equal(due.truncated, true);
  const next = await opened.completionReceipts.listCandidates({
    observedAtMs: 30,
    limit: 1,
    cursor: due.nextCursor,
  });
  assert.equal(next.candidates[0].attemptId, ATTEMPT_1);
  assert.equal(next.candidates[0].state, 'quarantined');
  assert.equal(await opened.completionReceipts.resolve(ATTEMPT_1), true);
  assert.equal(await opened.completionReceipts.resolve(ATTEMPT_1), false);
});

test('rejects a receipt registration that is not bound to a local Attempt', async (t) => {
  const opened = await database(t);
  await assert.rejects(
    opened.completionReceipts.register({
      runId: RUN_1,
      attemptId: ATTEMPT_1,
      registeredAtMs: 1,
    }),
    /does not match a local Attempt/,
  );
});
