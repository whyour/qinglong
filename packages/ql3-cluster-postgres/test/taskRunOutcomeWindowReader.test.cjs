const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  RunRepositoryConstraintError,
  RunRepositoryOperationError,
} = require('@qinglong/runtime-core/run-repository');
const {
  PostgresTaskRunOutcomeWindowReader,
} = require('@qinglong/cluster-postgres/task-run-outcome-window');

function harness(rows) {
  const queries = [];
  return {
    queries,
    queryable: {
      async query(text, values) {
        queries.push({ text, values });
        return { rows, rowCount: rows.length };
      },
    },
  };
}

test('reads one bounded PostgreSQL Project Task window with bigint normalization', async () => {
  assert.equal(
    require('@qinglong/cluster-postgres').PostgresTaskRunOutcomeWindowReader,
    undefined,
  );
  const value = harness([
    {
      id: 'run-failed',
      projectId: 'project-a',
      taskId: 'task-a',
      status: 'failed',
      createdAtMs: '2000',
    },
    {
      id: 'run-succeeded',
      projectId: 'project-a',
      taskId: 'task-a',
      status: 'succeeded',
      createdAtMs: '1000',
    },
  ]);
  const rows = await new PostgresTaskRunOutcomeWindowReader(
    value.queryable,
  ).listRecentRunsByTask({
    projectId: 'project-a',
    taskId: 'task-a',
    limit: 65,
  });

  assert.deepEqual(rows, [
    {
      id: 'run-failed',
      projectId: 'project-a',
      taskId: 'task-a',
      status: 'failed',
      createdAtMs: 2000,
    },
    {
      id: 'run-succeeded',
      projectId: 'project-a',
      taskId: 'task-a',
      status: 'succeeded',
      createdAtMs: 1000,
    },
  ]);
  assert.deepEqual(value.queries[0].values, ['project-a', 'task-a', 65]);
  assert.match(
    value.queries[0].text,
    /WHERE "project_id" = \$1 AND "task_id" = \$2[\s\S]*ORDER BY "created_at_ms" DESC, "id" DESC[\s\S]*LIMIT \$3/u,
  );
});

test('rejects invalid windows and maps driver failures without leaking details', async () => {
  const invalid = harness([
    {
      id: 'run-invalid',
      projectId: 'project-a',
      taskId: 'task-a',
      status: 'invented',
      createdAtMs: '1000',
    },
  ]);
  await assert.rejects(
    new PostgresTaskRunOutcomeWindowReader(
      invalid.queryable,
    ).listRecentRunsByTask({
      projectId: 'project-a',
      taskId: 'task-a',
      limit: 65,
    }),
    RunRepositoryConstraintError,
  );

  await assert.rejects(
    new PostgresTaskRunOutcomeWindowReader({
      async query() {
        throw new Error('postgresql://private-host/secret');
      },
    }).listRecentRunsByTask({
      projectId: 'project-a',
      taskId: 'task-a',
      limit: 65,
    }),
    (error) => {
      assert.ok(error instanceof RunRepositoryOperationError);
      assert.equal(error.message, 'Run repository operation failed');
      return true;
    },
  );
});
