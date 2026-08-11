require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  TASK_EXECUTION_REVISION_TABLE,
  taskExecutionRevisionMigration,
} = require('../../back/migrations/0012-task-execution-revisions');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeTaskExecutionRevisionRepository,
  TaskExecutionRevisionConflictError,
} = require('../../back/runtime/adapters/legacy-sequelize/taskExecutionRevisionRepository');
const {
  TaskExecutionRevisionCorruptError,
  taskExecutionRevisionDigest,
} = require('../../back/runtime/domain/taskExecutionRevisionRecord');

function revision(overrides = {}) {
  return {
    projectId: 'project-a',
    taskId: 'task-a',
    taskRevision: 'sha256:revision-a',
    executorType: 'local_process',
    execution: {
      command: {
        kind: 'argv',
        file: '/usr/bin/env',
        args: ['node', 'script.js'],
      },
      workingDirectory: '/work',
      environmentPolicy: 'isolated',
      timeoutMs: 60_000,
      terminationGraceMs: 5_000,
      resourcePolicy: {
        memoryBytes: { value: 128 * 1024 * 1024, enforcement: 'required' },
        networkIsolation: 'best_effort',
      },
    },
    contextRef: 'context://project-a/task-a/revision-a',
    ...overrides,
  };
}

async function createRepository(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [taskExecutionRevisionMigration],
    logger: { info() {} },
  });
  return {
    database,
    repository: new LegacySequelizeTaskExecutionRevisionRepository(database),
  };
}

test('uses a stable canonical digest vector shared by future adapters', () => {
  assert.equal(
    taskExecutionRevisionDigest(revision()),
    'a8df00094b9b37c24f707367801c915c188bb8bf224f4f5ab72ba8753e6e2cf5',
  );
  assert.equal(
    taskExecutionRevisionDigest({
      contextRef: revision().contextRef,
      execution: {
        networkIgnored: true,
        ...revision().execution,
      },
      executorType: revision().executorType,
      taskRevision: revision().taskRevision,
      taskId: revision().taskId,
      projectId: revision().projectId,
      ignored: true,
    }),
    'a8df00094b9b37c24f707367801c915c188bb8bf224f4f5ab72ba8753e6e2cf5',
  );
});

test('stores an immutable canonical revision and resolves only the exact identity', async (t) => {
  const { repository } = await createRepository(t);
  const input = revision();

  assert.equal(await repository.insert(input, 1_750_000_000_000), 'inserted');
  input.execution.command.args[0] = 'mutated-after-insert';
  input.execution.resourcePolicy.memoryBytes.value = 1;

  const stored = await repository.resolve({
    projectId: 'project-a',
    taskId: 'task-a',
    taskRevision: 'sha256:revision-a',
  });
  assert.ok(stored);
  assert.deepEqual(stored.execution.command.args, ['node', 'script.js']);
  assert.equal(stored.execution.resourcePolicy.memoryBytes.value, 134_217_728);
  assert.equal(stored.createdAtMs, 1_750_000_000_000);
  assert.match(stored.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(stored.contentDigest, taskExecutionRevisionDigest(stored));
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.execution));
  assert.ok(Object.isFrozen(stored.execution.command));
  assert.ok(Object.isFrozen(stored.execution.command.args));
  assert.ok(Object.isFrozen(stored.execution.resourcePolicy));
  assert.ok(Object.isFrozen(stored.execution.resourcePolicy.memoryBytes));

  assert.equal(
    await repository.resolve({
      projectId: 'project-a',
      taskId: 'task-a',
      taskRevision: 'sha256:revision-b',
    }),
    null,
  );
});

test('concurrent replay converges without replacing the first immutable row', async (t) => {
  const { repository } = await createRepository(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      repository.insert(revision(), 1_750_000_000_000 + index),
    ),
  );

  assert.equal(results.filter((result) => result === 'inserted').length, 1);
  assert.equal(results.filter((result) => result === 'idempotent').length, 11);
  const stored = await repository.resolve(revision());
  assert.ok(stored.createdAtMs >= 1_750_000_000_000);
  assert.ok(stored.createdAtMs <= 1_750_000_000_011);
});

test('same identity with different normalized content is an immutable conflict', async (t) => {
  const { repository } = await createRepository(t);
  assert.equal(await repository.insert(revision(), 100), 'inserted');
  assert.equal(
    await repository.insert(
      {
        ...revision(),
        unknownTopLevel: 'stripped',
        execution: {
          ...revision().execution,
          unknownExecutionField: 'stripped',
        },
      },
      101,
    ),
    'idempotent',
  );
  await assert.rejects(
    repository.insert(
      revision({
        execution: {
          ...revision().execution,
          command: { kind: 'shell', command: 'echo changed' },
        },
      }),
      102,
    ),
    TaskExecutionRevisionConflictError,
  );
});

test('fails closed when stored content or digest is corrupt', async (t) => {
  const { database, repository } = await createRepository(t);
  await repository.insert(revision(), 100);
  await database.getQueryInterface().bulkUpdate(
    TASK_EXECUTION_REVISION_TABLE,
    { content_digest: '0'.repeat(64) },
    {
      project_id: 'project-a',
      task_id: 'task-a',
      task_revision: 'sha256:revision-a',
    },
  );

  await assert.rejects(
    repository.resolve(revision()),
    TaskExecutionRevisionCorruptError,
  );
});

test('rejects invalid timestamps and prevents the SQLite adapter from serving cluster-control', async (t) => {
  const { repository } = await createRepository(t);
  await assert.rejects(repository.insert(revision(), -1), /createdAtMs/);
  assert.throws(
    () =>
      new LegacySequelizeTaskExecutionRevisionRepository({
        getDialect: () => 'postgres',
      }),
    /PostgreSQL adapter/,
  );
});
