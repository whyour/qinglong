const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createLocalExecutionContextRecipe,
  createLocalTaskExecutionRevision,
} = require('@qinglong/runtime-core/local-dispatch');
const {
  RunRepositoryConstraintError,
} = require('@qinglong/runtime-core/run-repository');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

async function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-dispatch-store-'),
  );
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

function run(id, priority, queuedAtMs, cancelled = false) {
  return {
    id: `run-${id}`,
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'queued',
    version: 0,
    eventSequence: 0,
    priority,
    createdAtMs: 1,
    queuedAtMs,
    ...(cancelled ? { cancelRequestedAtMs: 2, cancelReason: 'user' } : {}),
  };
}

function attempt(id, createdAtMs) {
  return {
    id: `attempt-${id}`,
    runId: `run-${id}`,
    attempt: 1,
    status: 'claimed',
    executorType: 'local_process',
    callbackSequence: 0,
    createdAtMs,
  };
}

test('append-only definitions replay by content and reject identity conflicts', async (t) => {
  const runtime = await fixture(t);
  const recipe = createLocalExecutionContextRecipe({
    environment: [{ name: 'VALUE', kind: 'public', value: 'one' }],
    createdAtMs: 1,
  });
  assert.equal(
    await runtime.localDispatch.appendLocalExecutionContextRecipe(recipe),
    'inserted',
  );
  assert.equal(
    await runtime.localDispatch.appendLocalExecutionContextRecipe({
      ...recipe,
      createdAtMs: 2,
    }),
    'existing',
  );
  const revision = createLocalTaskExecutionRevision({
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    command: { kind: 'argv', file: '/bin/echo', args: ['one'] },
    contextRef: recipe.contextRef,
    createdAtMs: 1,
  });
  assert.equal(
    await runtime.localDispatch.appendLocalTaskExecutionRevision(revision),
    'inserted',
  );
  assert.equal(
    await runtime.localDispatch.appendLocalTaskExecutionRevision({
      ...revision,
      createdAtMs: 2,
    }),
    'existing',
  );
  await assert.rejects(
    runtime.localDispatch.appendLocalTaskExecutionRevision(
      createLocalTaskExecutionRevision({
        ...revision,
        command: { kind: 'argv', file: '/bin/echo', args: ['different'] },
      }),
    ),
    RunRepositoryConstraintError,
  );
});

test('candidate pages are bounded, ordered and exclude cancellation intent', async (t) => {
  const runtime = await fixture(t);
  await runtime.runRepository.transaction(async (transaction) => {
    for (const value of [
      ['a', 10, 2, 2, false],
      ['b', 10, 1, 3, false],
      ['c', 5, 1, 1, false],
      ['cancelled', 100, 1, 1, true],
    ]) {
      await transaction.insertRun(run(value[0], value[1], value[2], value[4]));
      await transaction.insertAttempt(attempt(value[0], value[3]));
    }
  });
  const first = await runtime.localDispatch.listLocalDispatchCandidates({
    limit: 2,
  });
  assert.deepEqual(
    first.candidates.map(({ runId }) => runId),
    ['run-b', 'run-a'],
  );
  assert.equal(first.truncated, true);
  const last = first.candidates.at(-1);
  const second = await runtime.localDispatch.listLocalDispatchCandidates({
    limit: 2,
    after: {
      priority: last.priority,
      queuedAtMs: last.queuedAtMs,
      attemptCreatedAtMs: last.attemptCreatedAtMs,
      attemptId: last.attemptId,
    },
  });
  assert.deepEqual(
    second.candidates.map(({ runId }) => runId),
    ['run-c'],
  );
  assert.equal(second.truncated, false);
});
