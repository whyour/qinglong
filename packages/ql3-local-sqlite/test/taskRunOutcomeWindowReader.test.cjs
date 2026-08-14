const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');
const {
  openLocalSqliteMcpReadDatabase,
} = require('@qinglong/local-sqlite/mcp-read-database');
const {
  LocalSqliteTaskRunOutcomeWindowReader,
} = require('@qinglong/local-sqlite/task-run-outcome-window');

function run(id, projectId, taskId, status, createdAtMs) {
  return {
    id,
    projectId,
    taskId,
    taskRevision: 'revision-1',
    taskName: id,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: 'test',
    status,
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs,
  };
}

test('reads one fixed Project Task outcome window through the existing indexed SQLite authority', async (t) => {
  assert.equal(typeof LocalSqliteTaskRunOutcomeWindowReader, 'function');
  assert.equal(
    require('@qinglong/local-sqlite').LocalSqliteTaskRunOutcomeWindowReader,
    undefined,
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-outcome-window-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    profile: 'edge',
  };
  await migrateLocalSqlitePath(options);
  const runtime = await openLocalSqliteRuntimeDatabase(options);
  await runtime.runRepository.transaction(async (transaction) => {
    for (const value of [
      run('run-old-success', 'default', 'task-a', 'succeeded', 10),
      run('run-failure', 'default', 'task-a', 'failed', 20),
      run('run-running', 'default', 'task-a', 'running', 30),
      run('run-other-task', 'default', 'task-b', 'failed', 40),
      run('run-other-project', 'other', 'task-a', 'failed', 50),
    ]) {
      await transaction.insertRun(value);
    }
  });
  await runtime.close();

  const database = await openLocalSqliteMcpReadDatabase(options);
  t.after(() => database.close());
  const rows = await database.runs.listRecentRunsByTask({
    projectId: 'default',
    taskId: 'task-a',
    limit: 3,
  });
  assert.deepEqual(rows, [
    {
      id: 'run-running',
      projectId: 'default',
      taskId: 'task-a',
      status: 'running',
      createdAtMs: 30,
    },
    {
      id: 'run-failure',
      projectId: 'default',
      taskId: 'task-a',
      status: 'failed',
      createdAtMs: 20,
    },
    {
      id: 'run-old-success',
      projectId: 'default',
      taskId: 'task-a',
      status: 'succeeded',
      createdAtMs: 10,
    },
  ]);
  await assert.rejects(
    database.runs.listRecentRunsByTask({
      projectId: 'default',
      taskId: 'task-a',
      limit: 66,
    }),
    TypeError,
  );

  await database.close();
  const client = new DatabaseSync(options.databasePath, { readOnly: true });
  t.after(() => {
    if (client.isOpen) client.close();
  });
  const plan = client
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT "id", "project_id", "task_id", "status", "created_at_ms"
       FROM "Runs"
       WHERE "project_id" = ? AND "task_id" = ?
       ORDER BY "created_at_ms" DESC, "id" DESC
       LIMIT ?`,
    )
    .all('default', 'task-a', 65);
  assert.match(
    plan.map((entry) => entry.detail).join('\n'),
    /ql3_local_runs_task_created_idx/u,
  );
});
