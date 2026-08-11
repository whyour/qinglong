require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  PROJECT_ROLE_BINDING_CURRENT_INDEX,
  PROJECT_ROLE_BINDING_MUTATION_INDEX,
  PROJECT_ROLE_BINDING_SUBJECT_INDEX,
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_SLUG_INDEX,
  PROJECT_TABLE,
  projectPolicyMigration,
} = require('../../back/migrations/0017-project-policy');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeProjectPolicyRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectPolicyRepository');
const {
  ProjectPolicyArtifactReadAuthorizer,
} = require('../../back/runtime/adapters/policy/projectPolicyArtifactReadAuthorizer');
const {
  ProjectPolicyEngine,
} = require('../../back/runtime/application/projectPolicyEngine');
const {
  LocalArtifactReadService,
} = require('../../back/runtime/application/localArtifactReadService');
const {
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  normalizeProjectPermission,
  normalizeProjectRoleBindingRecord,
} = require('../../back/runtime/domain/projectPolicy');

const PROJECT_ID = 'default';
const CHANGED_BY = Object.freeze({ type: 'user', id: 'local-owner' });

async function setup(t, storage = ':memory:') {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [projectPolicyMigration],
    logger: { info() {} },
  });
  return {
    database,
    repository: new LegacySequelizeProjectPolicyRepository(database),
  };
}

function binding({
  subject = { type: 'user', id: 'user-1' },
  version = 1,
  role = 'viewer',
  state = 'active',
  mutationId = 'mutation-1',
  createdAtMs = version,
} = {}) {
  return {
    projectId: PROJECT_ID,
    subject,
    version,
    state,
    ...(state === 'active' ? { role } : {}),
    mutationId,
    changedBy: CHANGED_BY,
    createdAtMs,
  };
}

async function append(repository, value, expectedCurrentVersion) {
  return repository.append({
    expectedCurrentVersion,
    binding: value,
  });
}

test('migration creates an ownerless default Project and bounded lookup indexes', async (t) => {
  const { database, repository } = await setup(t);
  const projects = await database
    .getQueryInterface()
    .select(null, PROJECT_TABLE);
  assert.deepEqual(projects, [
    {
      id: 'default',
      name: 'Default',
      slug: 'default',
      status: 'active',
      version: 1,
      created_at_ms: 0,
      updated_at_ms: 0,
    },
  ]);
  assert.deepEqual(
    await repository.resolve(PROJECT_ID, { type: 'user', id: 'local-owner' }),
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
    },
  );
  const projectIndexes = new Set(
    (await database.getQueryInterface().showIndex(PROJECT_TABLE)).map(
      (index) => index.name,
    ),
  );
  const bindingIndexes = new Set(
    (
      await database.getQueryInterface().showIndex(PROJECT_ROLE_BINDING_TABLE)
    ).map((index) => index.name),
  );
  assert.ok(projectIndexes.has(PROJECT_SLUG_INDEX));
  assert.ok(bindingIndexes.has(PROJECT_ROLE_BINDING_CURRENT_INDEX));
  assert.ok(bindingIndexes.has(PROJECT_ROLE_BINDING_MUTATION_INDEX));
  assert.ok(bindingIndexes.has(PROJECT_ROLE_BINDING_SUBJECT_INDEX));
});

test('normalizes only declared permissions and exact tool identities', () => {
  assert.equal(normalizeProjectPermission('artifact.read'), 'artifact.read');
  assert.equal(
    normalizeProjectPermission('tool.call:github.issue.read'),
    'tool.call:github.issue.read',
  );
  for (const value of [
    'logs',
    'artifact.write',
    'tool.call:*',
    'tool.call:',
    'tool.call:bad value',
  ]) {
    assert.throws(
      () => normalizeProjectPermission(value),
      /permission is invalid/,
    );
  }
  assert.throws(
    () =>
      normalizeProjectRoleBindingRecord({
        ...binding({ state: 'revoked' }),
        role: 'viewer',
      }),
    /shape is invalid/,
  );
  assert.throws(
    () =>
      normalizeProjectRoleBindingRecord({
        ...binding(),
        permissions: ['artifact.read'],
      }),
    /shape is invalid/,
  );
});

test('appends immutable role versions, replays mutations and resolves latest state', async (t) => {
  const { repository } = await setup(t);
  const first = binding();
  assert.deepEqual(await append(repository, first, 0), {
    status: 'inserted',
    binding: first,
  });
  assert.deepEqual(await append(repository, first, 0), {
    status: 'existing',
    binding: first,
  });
  await assert.rejects(
    append(repository, { ...first, role: 'operator' }, 0),
    ProjectRoleBindingMutationConflictError,
  );
  await assert.rejects(
    append(repository, binding({ mutationId: 'stale-mutation' }), 0),
    ProjectRoleBindingVersionConflictError,
  );

  const second = binding({
    version: 2,
    role: 'operator',
    mutationId: 'mutation-2',
  });
  assert.equal((await append(repository, second, 1)).status, 'inserted');
  assert.deepEqual(
    (await repository.resolve(PROJECT_ID, first.subject)).binding,
    second,
  );

  const revoked = binding({
    version: 3,
    state: 'revoked',
    mutationId: 'mutation-3',
  });
  assert.equal((await append(repository, revoked, 2)).status, 'inserted');
  assert.deepEqual(
    (await repository.resolve(PROJECT_ID, first.subject)).binding,
    revoked,
  );
});

test('serializes concurrent first assignments so only one current version wins', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-policy-db-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'database.sqlite');
  const { repository } = await setup(t, storage);
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondRepository = new LegacySequelizeProjectPolicyRepository(
    secondDatabase,
  );
  const subject = { type: 'api_app', id: 'app-1' };
  const results = await Promise.allSettled([
    append(
      secondRepository,
      binding({ subject, role: 'viewer', mutationId: 'concurrent-a' }),
      0,
    ),
    append(
      repository,
      binding({ subject, role: 'operator', mutationId: 'concurrent-b' }),
      0,
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected.reason instanceof ProjectRoleBindingVersionConflictError);
  const snapshot = await repository.resolve(PROJECT_ID, subject);
  assert.equal(snapshot.binding.version, 1);
  assert.ok(['viewer', 'operator'].includes(snapshot.binding.role));
});

test('defaults to deny and applies viewer, operator, archive and revocation rules', async (t) => {
  const { database, repository } = await setup(t);
  const engine = new ProjectPolicyEngine(repository);
  const viewer = { type: 'user', id: 'viewer-1' };
  assert.deepEqual(
    await engine.decide({
      subject: viewer,
      projectId: 'missing',
      permission: 'artifact.read',
    }),
    { effect: 'deny', reasons: ['project_not_found'] },
  );
  assert.deepEqual(
    await engine.decide({
      subject: viewer,
      projectId: PROJECT_ID,
      permission: 'artifact.read',
    }),
    { effect: 'deny', reasons: ['subject_unbound'] },
  );
  await append(
    repository,
    binding({ subject: viewer, role: 'viewer', mutationId: 'viewer-bind' }),
    0,
  );
  assert.equal(
    (
      await engine.decide({
        subject: viewer,
        projectId: PROJECT_ID,
        permission: 'artifact.read',
      })
    ).effect,
    'allow',
  );
  assert.deepEqual(
    await engine.decide({
      subject: viewer,
      projectId: PROJECT_ID,
      permission: 'run.start',
    }),
    { effect: 'deny', reasons: ['permission_missing'] },
  );

  const operator = binding({
    subject: viewer,
    version: 2,
    role: 'operator',
    mutationId: 'viewer-promote',
  });
  await append(repository, operator, 1);
  assert.equal(
    (
      await engine.decide({
        subject: viewer,
        projectId: PROJECT_ID,
        permission: 'run.start',
      })
    ).effect,
    'allow',
  );
  await database
    .getQueryInterface()
    .bulkUpdate(
      PROJECT_TABLE,
      { status: 'archived', version: 2, updated_at_ms: 2 },
      { id: PROJECT_ID },
    );
  assert.deepEqual(
    await engine.decide({
      subject: viewer,
      projectId: PROJECT_ID,
      permission: 'run.start',
    }),
    { effect: 'deny', reasons: ['project_archived'] },
  );
  assert.equal(
    (
      await engine.decide({
        subject: viewer,
        projectId: PROJECT_ID,
        permission: 'artifact.read',
      })
    ).effect,
    'allow',
  );

  await append(
    repository,
    binding({
      subject: viewer,
      version: 3,
      state: 'revoked',
      mutationId: 'viewer-revoke',
    }),
    2,
  );
  assert.deepEqual(
    await engine.decide({
      subject: viewer,
      projectId: PROJECT_ID,
      permission: 'artifact.read',
    }),
    { effect: 'deny', reasons: ['subject_unbound'] },
  );
});

test('requires approval for Agent mutations while allowing bound reads', async (t) => {
  const { repository } = await setup(t);
  const engine = new ProjectPolicyEngine(repository);
  const agent = { type: 'agent', id: 'agent-1' };
  await append(
    repository,
    binding({ subject: agent, role: 'operator', mutationId: 'agent-bind' }),
    0,
  );
  assert.deepEqual(
    await engine.decide({
      subject: agent,
      projectId: PROJECT_ID,
      permission: 'run.start',
    }),
    {
      effect: 'require_approval',
      reasons: ['agent_action_requires_approval'],
    },
  );
  assert.deepEqual(
    await engine.decide({
      subject: agent,
      projectId: PROJECT_ID,
      permission: 'tool.call:github.issue.read',
    }),
    {
      effect: 'require_approval',
      reasons: ['agent_action_requires_approval'],
    },
  );
  assert.equal(
    (
      await engine.decide({
        subject: agent,
        projectId: PROJECT_ID,
        permission: 'artifact.read',
      })
    ).effect,
    'allow',
  );
});

test('enforces the owner, admin, operator and viewer permission matrix', async (t) => {
  const { repository } = await setup(t);
  const engine = new ProjectPolicyEngine(repository);
  const cases = [
    {
      role: 'owner',
      allow: [
        'project.manage',
        'policy.manage',
        'task.delete',
        'approval.recover',
      ],
      deny: [],
    },
    {
      role: 'admin',
      allow: [
        'policy.manage',
        'task.delete',
        'secret.manage',
        'approval.recover',
      ],
      deny: ['project.manage'],
    },
    {
      role: 'operator',
      allow: ['task.update', 'run.start', 'secret.use'],
      deny: [
        'task.delete',
        'secret.manage',
        'policy.manage',
        'approval.recover',
      ],
    },
    {
      role: 'viewer',
      allow: ['project.read', 'task.read', 'run.read', 'artifact.read'],
      deny: ['task.update', 'run.start', 'secret.use', 'approval.recover'],
    },
  ];
  for (const [index, item] of cases.entries()) {
    const subject = { type: 'user', id: `${item.role}-user` };
    await append(
      repository,
      binding({
        subject,
        role: item.role,
        mutationId: `matrix-${index}`,
      }),
      0,
    );
    for (const permission of item.allow) {
      assert.equal(
        (await engine.decide({ subject, projectId: PROJECT_ID, permission }))
          .effect,
        'allow',
        `${item.role} should allow ${permission}`,
      );
    }
    for (const permission of item.deny) {
      assert.equal(
        (await engine.decide({ subject, projectId: PROJECT_ID, permission }))
          .effect,
        'deny',
        `${item.role} should deny ${permission}`,
      );
    }
  }
});

test('Artifact authorizer delegates only the bound subject, Project and permission', async () => {
  const calls = [];
  const authorizer = new ProjectPolicyArtifactReadAuthorizer({
    async decide(value) {
      calls.push(value);
      return { effect: 'require_approval', reasons: ['test'] };
    },
  });
  const effect = await authorizer.authorize({
    action: 'artifact.read',
    subject: { type: 'api_app', id: 'app-1' },
    projectId: PROJECT_ID,
    runId: '019f7600-0000-7000-8000-000000000001',
    logArtifactId: `local-${'e'.repeat(30)}`,
  });
  assert.equal(effect, 'require_approval');
  assert.deepEqual(calls, [
    {
      subject: { type: 'api_app', id: 'app-1' },
      projectId: PROJECT_ID,
      permission: 'artifact.read',
    },
  ]);
  await assert.rejects(
    authorizer.authorize({
      action: 'artifact.delete',
      subject: { type: 'api_app', id: 'app-1' },
      projectId: PROJECT_ID,
      runId: '019f7600-0000-7000-8000-000000000001',
      logArtifactId: `local-${'e'.repeat(30)}`,
    }),
    /action is invalid/,
  );
});

test('real Policy Core keeps Artifact bytes unreachable until a viewer binding exists', async (t) => {
  const { repository } = await setup(t);
  const subject = { type: 'api_app', id: 'artifact-client' };
  const runId = '019f7600-0000-7000-8000-000000000001';
  const attemptId = '019f7600-0000-7000-8000-000000000002';
  const logArtifactId = `local-${'e'.repeat(30)}`;
  let byteReads = 0;
  const service = new LocalArtifactReadService(
    {
      async find() {
        return {
          projectId: PROJECT_ID,
          runId,
          attemptId,
          logArtifactId,
        };
      },
    },
    new ProjectPolicyArtifactReadAuthorizer(
      new ProjectPolicyEngine(repository),
    ),
    {
      async read() {
        byteReads += 1;
        return {
          status: 'available',
          content: Buffer.from('log'),
          start: 0,
          endExclusive: 3,
          totalBytes: 3,
        };
      },
    },
    {
      async read() {
        return null;
      },
    },
  );
  const request = {
    subject,
    projectId: PROJECT_ID,
    runId,
    logArtifactId,
    range: { offset: 0, length: 1024 },
  };
  assert.deepEqual(await service.read(request), {
    status: 'forbidden',
    effect: 'deny',
  });
  assert.equal(byteReads, 0);

  await append(
    repository,
    binding({ subject, role: 'viewer', mutationId: 'artifact-viewer' }),
    0,
  );
  const available = await service.read(request);
  assert.equal(available.status, 'available');
  assert.equal(available.content.toString(), 'log');
  assert.equal(byteReads, 1);
});

test('fails closed for corrupt current bindings and non-SQLite adapters', async (t) => {
  const { database, repository } = await setup(t);
  const current = binding();
  await append(repository, current, 0);
  await database.getQueryInterface().bulkUpdate(
    PROJECT_ROLE_BINDING_TABLE,
    { role: null },
    {
      project_id: current.projectId,
      subject_type: current.subject.type,
      subject_id: current.subject.id,
      version: current.version,
    },
  );
  await assert.rejects(
    repository.resolve(PROJECT_ID, current.subject),
    ProjectPolicyUnavailableError,
  );
  assert.throws(
    () =>
      new LegacySequelizeProjectPolicyRepository({
        getDialect() {
          return 'postgres';
        },
      }),
    /SQLite-only/,
  );
});
