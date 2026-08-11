const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
} = require('@qinglong/runtime-core/project-policy');
const {
  PostgresProjectPolicyRepository,
} = require('../dist/security/projectPolicyRepository');

const BINDING = Object.freeze({
  projectId: 'default',
  subject: Object.freeze({ type: 'user', id: 'usr_primary' }),
  version: 1,
  state: 'active',
  role: 'owner',
  mutationId: 'grant-owner-1',
  changedBy: Object.freeze({ type: 'system', id: 'bootstrap' }),
  createdAtMs: 1,
});

function bindingRow(overrides = {}) {
  return {
    projectId: 'default',
    subjectType: 'user',
    subjectId: 'usr_primary',
    version: 1,
    state: 'active',
    role: 'owner',
    mutationId: 'grant-owner-1',
    changedByType: 'system',
    changedById: 'bootstrap',
    createdAtMs: '1',
    ...overrides,
  };
}

function snapshotRow(overrides = {}) {
  return {
    projectId: 'default',
    projectName: 'Default',
    projectSlug: 'default',
    projectStatus: 'active',
    projectVersion: 1,
    projectCreatedAtMs: '0',
    projectUpdatedAtMs: '0',
    bindingProjectId: 'default',
    bindingSubjectType: 'user',
    bindingSubjectId: 'usr_primary',
    bindingVersion: 1,
    bindingState: 'active',
    bindingRole: 'owner',
    bindingMutationId: 'grant-owner-1',
    bindingChangedByType: 'system',
    bindingChangedById: 'bootstrap',
    bindingCreatedAtMs: '1',
    ...overrides,
  };
}

test('resolves one normalized Project and latest RoleBinding snapshot', async () => {
  const queries = [];
  const repository = new PostgresProjectPolicyRepository({
    async query(text, values) {
      queries.push({ text, values });
      return { rows: [snapshotRow()] };
    },
    async connect() {
      throw new Error('not used');
    },
  });
  assert.deepEqual(
    await repository.resolve('default', { type: 'user', id: 'usr_primary' }),
    {
      project: {
        id: 'default',
        name: 'Default',
        slug: 'default',
        status: 'active',
        version: 1,
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      binding: BINDING,
    },
  );
  assert.deepEqual(queries[0].values, ['default', 'user', 'usr_primary']);
  assert.match(queries[0].text, /LEFT JOIN LATERAL/);
  assert.match(queries[0].text, /ORDER BY candidate\.version DESC/);
  await assert.rejects(
    repository.resolve('x'.repeat(129), {
      type: 'user',
      id: 'usr_primary',
    }),
  );
  assert.equal(queries.length, 1);
});

function appendPool(options = {}) {
  const events = [];
  let connection = 0;
  return {
    events,
    pool: {
      async query() {
        throw new Error('not used');
      },
      async connect() {
        connection += 1;
        let inserted = false;
        return {
          async query(text) {
            events.push(text.split('\n', 1)[0]);
            if (text.startsWith('SELECT id FROM'))
              return { rows: [{ id: 'default' }] };
            if (text.includes('mutation_id = $2')) {
              return {
                rows: options.replay ? [bindingRow(options.replay)] : [],
              };
            }
            if (text.startsWith('SELECT version FROM')) {
              return {
                rows:
                  options.currentVersion === undefined
                    ? []
                    : [{ version: options.currentVersion }],
              };
            }
            if (text.startsWith('INSERT INTO')) {
              if (options.retryOnce && connection === 1 && !inserted) {
                inserted = true;
                throw Object.assign(new Error('serialization'), {
                  code: '40001',
                });
              }
              return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
          },
          release() {
            events.push(`release:${connection}`);
          },
        };
      },
    },
  };
}

test('appends under a serializable Project lock and replays exactly', async () => {
  const insertedFixture = appendPool();
  const inserted = await new PostgresProjectPolicyRepository(
    insertedFixture.pool,
  ).append({ expectedCurrentVersion: 0, binding: BINDING });
  assert.deepEqual(inserted, { status: 'inserted', binding: BINDING });
  assert.equal(
    insertedFixture.events.some((event) =>
      event.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE'),
    ),
    true,
  );
  assert.ok(
    insertedFixture.events.findIndex((event) => event.startsWith('SELECT id')) <
      insertedFixture.events.findIndex((event) => event.startsWith('INSERT')),
  );
  assert.ok(insertedFixture.events.includes('COMMIT'));

  const replayFixture = appendPool({ replay: {} });
  const replay = await new PostgresProjectPolicyRepository(
    replayFixture.pool,
  ).append({ expectedCurrentVersion: 0, binding: BINDING });
  assert.deepEqual(replay, { status: 'existing', binding: BINDING });
  assert.equal(
    replayFixture.events.some((event) => event.startsWith('INSERT')),
    false,
  );
});

test('rejects stale versions and conflicting mutation replay', async () => {
  await assert.rejects(
    new PostgresProjectPolicyRepository(
      appendPool({ currentVersion: 1 }).pool,
    ).append({ expectedCurrentVersion: 0, binding: BINDING }),
    ProjectRoleBindingVersionConflictError,
  );
  await assert.rejects(
    new PostgresProjectPolicyRepository(
      appendPool({ replay: { role: 'viewer' } }).pool,
    ).append({ expectedCurrentVersion: 0, binding: BINDING }),
    ProjectRoleBindingMutationConflictError,
  );
});

test('retries serialization failures but fails closed on corrupt rows', async () => {
  const retryFixture = appendPool({ retryOnce: true });
  assert.equal(
    (
      await new PostgresProjectPolicyRepository(retryFixture.pool).append({
        expectedCurrentVersion: 0,
        binding: BINDING,
      })
    ).status,
    'inserted',
  );
  assert.equal(
    retryFixture.events.filter((event) => event.startsWith('release:')).length,
    2,
  );

  const repository = new PostgresProjectPolicyRepository({
    async query() {
      return { rows: [snapshotRow({ projectVersion: 'not-a-number' })] };
    },
    async connect() {
      throw new Error('not used');
    },
  });
  await assert.rejects(
    repository.resolve('default', { type: 'user', id: 'usr_primary' }),
    ProjectPolicyUnavailableError,
  );
});
