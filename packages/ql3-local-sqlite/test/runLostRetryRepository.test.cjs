'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-lost-retry-'));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}

async function insertLostRun(runtime, suffix, retryPolicy) {
  const runId = `run-lost-${suffix}`;
  const attemptId = `attempt-lost-${suffix}`;
  await runtime.runRepository.transaction(async (transaction) => {
    await transaction.insertRun({
      id: runId,
      projectId: 'default',
      taskId: `task-${suffix}`,
      taskRevision: 'revision-1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      status: 'lost',
      version: 1,
      eventSequence: 1,
      priority: 0,
      createdAtMs: 100,
      queuedAtMs: 110,
      startedAtMs: 120,
      errorCode: 'LOCAL_RECOVERY_EXECUTION_NOT_RUNNING',
      errorSummary: 'lost',
    });
    await transaction.insertAttempt({
      id: attemptId,
      runId,
      attempt: 1,
      status: 'lost',
      executorType: 'local_process',
      callbackSequence: 0,
      createdAtMs: 110,
      startedAtMs: 120,
      finishedAtMs: 130,
      errorCode: 'LOCAL_RECOVERY_EXECUTION_NOT_RUNNING',
      errorSummary: 'lost',
    });
    if (retryPolicy) {
      await transaction.insertRetryPolicy({
        runId,
        maxAttempts: 3,
        retryOnLost: true,
        safety: 'idempotent',
        backoffBaseMs: 0,
        backoffMaxMs: 0,
        version: 0,
        createdAtMs: 100,
        updatedAtMs: 100,
      });
    }
  });
  return { runId, attemptId };
}

test('atomically schedules and requeues one safe Local lost Run exactly once', async (t) => {
  const runtime = await fixture(t);
  const ids = await insertLostRun(runtime, 'safe', true);

  assert.deepEqual(await runtime.runLostRetry.reconcilePage({ limit: 1 }), {
    scanned: 1,
    scheduled: 1,
    requeued: 0,
    failed: 0,
    raced: 0,
    hasMore: false,
  });
  assert.equal(
    (await runtime.runRepository.findRunById(ids.runId)).status,
    'retry_wait',
  );

  assert.deepEqual(await runtime.runLostRetry.reconcilePage({ limit: 1 }), {
    scanned: 1,
    scheduled: 0,
    requeued: 1,
    failed: 0,
    raced: 0,
    hasMore: false,
  });
  const run = await runtime.runRepository.findRunById(ids.runId);
  const attempt = await runtime.runRepository.findLatestAttemptByRunId(
    ids.runId,
  );
  assert.equal(run.status, 'queued');
  assert.equal(run.version, 4);
  assert.equal(attempt.attempt, 2);
  assert.equal(attempt.status, 'claimed');
  assert.equal(attempt.executorType, 'local_process');
  assert.deepEqual(
    (await runtime.runRepository.listEvents(ids.runId)).map(
      (event) => event.type,
    ),
    ['run.retry_wait', 'run.queued', 'attempt.claimed'],
  );
  assert.equal(
    (await runtime.runLostRetry.reconcilePage({ limit: 1 })).scanned,
    0,
  );
});

test('fails closed without an admitted retry policy and preserves a bounded page', async (t) => {
  const runtime = await fixture(t);
  const first = await insertLostRun(runtime, 'disabled-a', false);
  await insertLostRun(runtime, 'disabled-b', false);

  const result = await runtime.runLostRetry.reconcilePage({ limit: 1 });
  assert.deepEqual(result, {
    scanned: 1,
    scheduled: 0,
    requeued: 0,
    failed: 1,
    raced: 0,
    hasMore: true,
  });
  assert.equal(
    (await runtime.runRepository.findRunById(first.runId)).errorCode,
    'RUN_LOST_RETRY_DISABLED',
  );
  await assert.rejects(
    runtime.runLostRetry.reconcilePage({ limit: 65 }),
    /page size/,
  );
});
