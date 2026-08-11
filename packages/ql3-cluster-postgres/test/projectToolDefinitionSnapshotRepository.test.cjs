const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createProjectToolDefinitionSnapshot,
  ProjectToolDefinitionSnapshotConflictError,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  PostgresProjectToolDefinitionSnapshotRepository,
} = require('../dist/tool-execution/projectToolDefinitionSnapshotRepository');

function fakePool() {
  const queries = [];
  const snapshots = new Map();
  const client = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (
        text.startsWith('BEGIN') ||
        text.startsWith('SELECT set_config') ||
        text === 'COMMIT' ||
        text === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      if (text.includes('FROM "ql3"."plugin_package_install_heads"')) {
        return { rows: [] };
      }
      if (
        text.startsWith('INSERT INTO "ql3"."project_tool_definition_snapshots"')
      ) {
        const key = `${values[0]}:${values[1]}`;
        if (snapshots.has(key)) return { rows: [] };
        snapshots.set(key, {
          projectId: values[0],
          activeVectorDigest: values[1],
          definitionsDigest: values[2],
          snapshotDigest: values[3],
          snapshotJson: JSON.parse(values[4]),
          committedAtMs: 500,
        });
        return { rows: [{ activeVectorDigest: values[1] }] };
      }
      if (text.includes('FROM "ql3"."project_tool_definition_snapshots"')) {
        const row = snapshots.get(`${values[0]}:${values[1]}`);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (
        text.includes('FROM "ql3"."project_tool_definition_snapshot_sources"')
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {},
  };
  return {
    queries,
    pool: {
      query: (...args) => client.query(...args),
      async connect() {
        return client;
      },
    },
    corrupt(snapshot) {
      snapshots.get(
        `${snapshot.projectId}:${snapshot.activeVectorDigest}`,
      ).snapshotJson.snapshotDigest = 'f'.repeat(64);
    },
  };
}

test('publishes and exactly replays one empty PostgreSQL snapshot', async () => {
  const value = fakePool();
  const repository = new PostgresProjectToolDefinitionSnapshotRepository(
    value.pool,
  );
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-postgres-snapshot',
    contributions: [],
  });

  assert.equal(await repository.findCurrent(snapshot.projectId), null);
  const created = await repository.publish(snapshot);
  assert.equal(created.status, 'created');
  assert.deepEqual(created.record.snapshot, snapshot);
  assert.equal((await repository.publish(snapshot)).status, 'existing');
  assert.deepEqual(
    await repository.findCurrent(snapshot.projectId),
    created.record,
  );
  assert.match(
    value.queries.find(({ text }) =>
      text.startsWith('INSERT INTO "ql3"."project_tool_definition_snapshots"'),
    ).text,
    /clock_timestamp\(\)/,
  );
  assert.equal(
    value.queries.some(({ text }) =>
      text.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    ),
    true,
  );
});

test('fails closed for corrupted PostgreSQL snapshot JSON', async () => {
  const value = fakePool();
  const repository = new PostgresProjectToolDefinitionSnapshotRepository(
    value.pool,
  );
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-postgres-corrupt',
    contributions: [],
  });
  await repository.publish(snapshot);
  value.corrupt(snapshot);
  await assert.rejects(
    repository.findCurrent(snapshot.projectId),
    /snapshot is unavailable/,
  );
});

test('maps PostgreSQL constraint rejection to snapshot conflict', async () => {
  const repository = new PostgresProjectToolDefinitionSnapshotRepository({
    async query() {
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text) {
          if (
            text.startsWith('BEGIN') ||
            text.startsWith('SELECT set_config')
          ) {
            return { rows: [] };
          }
          const error = new Error('constraint');
          error.code = '23505';
          throw error;
        },
        release() {},
      };
    },
  });
  const snapshot = createProjectToolDefinitionSnapshot({
    projectId: 'project-postgres-conflict',
    contributions: [],
  });
  await assert.rejects(
    repository.publish(snapshot),
    ProjectToolDefinitionSnapshotConflictError,
  );
});

test('publishes PostgreSQL snapshot storage only through executor subpaths', () => {
  assert.equal(
    require('@qinglong/cluster-postgres/project-tool-definition-snapshot')
      .PostgresProjectToolDefinitionSnapshotRepository,
    PostgresProjectToolDefinitionSnapshotRepository,
  );
  assert.equal(
    require('../dist/entrypoints/packageExecutor')
      .PostgresProjectToolDefinitionSnapshotRepository,
    PostgresProjectToolDefinitionSnapshotRepository,
  );
  assert.equal(
    require('../dist').PostgresProjectToolDefinitionSnapshotRepository,
    undefined,
  );
});
