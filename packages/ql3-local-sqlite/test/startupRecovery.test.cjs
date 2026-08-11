const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES,
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

async function database(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-startup-recovery-'),
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

function run(id, status, executionOwner = 'runtime') {
  return {
    id,
    projectId: 'default',
    taskId: `task-${id}`,
    taskRevision: `revision-${id}`,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner,
    status,
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: 1,
  };
}

function attempt(id, runId, status = 'running') {
  return {
    id,
    runId,
    attempt: 1,
    status,
    executorType: 'local_process',
    callbackSequence: 0,
    createdAtMs: 1,
  };
}

test('finds only runtime-owned dispatching or running Runs', async (t) => {
  const opened = await database(t);
  await opened.runRepository.transaction(async (transaction) => {
    await transaction.insertRun(run('run-1', 'running'));
    await transaction.insertAttempt(attempt('attempt-1', 'run-1'));
    await transaction.insertRun(run('run-2', 'dispatching'));
    await transaction.insertRun(run('run-3', 'succeeded'));
    await transaction.insertRun(run('run-4', 'running', 'legacy'));
  });

  const page = await opened.startupRecovery.inspectCandidates();
  assert.deepEqual(page, {
    candidates: [
      {
        runId: 'run-1',
        runStatus: 'running',
        activeAttemptCount: 1,
      },
      {
        runId: 'run-2',
        runStatus: 'dispatching',
        activeAttemptCount: 0,
      },
    ],
    truncated: false,
  });
});

test('returns a bounded deterministic page and explicit truncation', async (t) => {
  const opened = await database(t);
  await opened.runRepository.transaction(async (transaction) => {
    await transaction.insertRun(run('run-3', 'running'));
    await transaction.insertRun(run('run-1', 'running'));
    await transaction.insertRun(run('run-2', 'running'));
  });

  assert.deepEqual(
    await opened.startupRecovery.inspectCandidates({ limit: 2 }),
    {
      candidates: [
        {
          runId: 'run-1',
          runStatus: 'running',
          activeAttemptCount: 0,
        },
        {
          runId: 'run-2',
          runStatus: 'running',
          activeAttemptCount: 0,
        },
      ],
      truncated: true,
    },
  );
});

test('rejects invalid limits and shares repository close fencing', async (t) => {
  const opened = await database(t);
  await assert.rejects(
    opened.startupRecovery.inspectCandidates({ limit: 0 }),
    /limit must be between 1/,
  );
  await assert.rejects(
    opened.startupRecovery.inspectCandidates({
      limit: MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES + 1,
    }),
    /limit must be between 1/,
  );
  await opened.close();
  await assert.rejects(
    opened.startupRecovery.inspectCandidates(),
    (error) =>
      error &&
      error.name === 'RunRepositoryOperationError' &&
      error.cause instanceof Error &&
      error.cause.message === 'Local SQLite Run repository is closed',
  );
});
