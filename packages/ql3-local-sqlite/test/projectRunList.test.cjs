const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

function run(id, projectId, createdAtMs) {
  return {
    id,
    projectId,
    taskId: `task-${id}`,
    taskRevision: 'revision-1',
    taskName: id,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: 'test',
    status: 'created',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs,
  };
}

test('lists only one Project with descending keyset pagination', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-run-list-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    profile: 'edge',
  };
  await migrateLocalSqlitePath(options);
  const runtime = await openLocalSqliteRuntimeDatabase(options);
  t.after(() => runtime.close());
  await runtime.runRepository.transaction(async (transaction) => {
    for (const value of [
      run('run-a', 'default', 10),
      run('run-b', 'default', 20),
      run('run-c', 'default', 20),
      run('run-other', 'other', 30),
    ]) {
      await transaction.insertRun(value);
    }
  });
  const first = await runtime.runRepository.listRunsByProject({
    projectId: 'default',
    limit: 2,
  });
  assert.deepEqual(
    first.map(({ id }) => id),
    ['run-c', 'run-b'],
  );
  const second = await runtime.runRepository.listRunsByProject({
    projectId: 'default',
    limit: 2,
    after: { createdAtMs: 20, runId: 'run-b' },
  });
  assert.deepEqual(
    second.map(({ id }) => id),
    ['run-a'],
  );
  await assert.rejects(
    runtime.runRepository.listRunsByProject({
      projectId: 'default',
      limit: 66,
    }),
    TypeError,
  );
  await assert.rejects(
    runtime.runRepository.listRunsByProject({
      projectId: 'default',
      limit: 1,
      after: { createdAtMs: 20, runId: 'run-b', extra: true },
    }),
    TypeError,
  );
});
