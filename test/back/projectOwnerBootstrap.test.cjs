require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_TABLE,
  projectPolicyMigration,
} = require('../../back/migrations/0017-project-policy');
const {
  PROJECT_OWNER_BOOTSTRAP_CHALLENGE_ID_INDEX,
  PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
  PROJECT_OWNER_BOOTSTRAP_CURRENT_INDEX,
  projectOwnerBootstrapMigration,
} = require('../../back/migrations/0018-project-owner-bootstrap');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeProjectOwnerBootstrapRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectOwnerBootstrapRepository');
const {
  LegacySequelizeProjectPolicyRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectPolicyRepository');
const {
  ProjectOwnerBootstrapService,
} = require('../../back/runtime/application/projectOwnerBootstrapService');
const {
  AuthenticatedPrincipalExpiredError,
  normalizeAuthenticatedPrincipal,
} = require('../../back/runtime/domain/authenticatedPrincipal');
const {
  ProjectOwnerBootstrapChallengeActiveError,
  ProjectOwnerBootstrapClaimRejectedError,
  ProjectOwnerBootstrapProjectInactiveError,
  ProjectOwnerBootstrapProjectNotFoundError,
  ProjectOwnerBootstrapProjectNotPristineError,
  ProjectOwnerBootstrapUnauthorizedError,
  ProjectOwnerBootstrapUnavailableError,
} = require('../../back/runtime/domain/projectOwnerBootstrap');

const PROJECT_ID = 'default';
const NOW = 100_000;
const TTL_MS = 60_000;

function principal(subject = { type: 'user', id: 'owner-1' }, overrides = {}) {
  return {
    subject,
    authenticationId: 'auth-1',
    authenticatedAtMs: 0,
    expiresAtMs: NOW + TTL_MS * 10,
    assurance: 'multi_factor',
    ...overrides,
  };
}

function localConsolePrincipal(overrides = {}) {
  return principal(
    { type: 'system', id: 'owner-bootstrap' },
    { assurance: 'local_console', ...overrides },
  );
}

function deterministicRandomSource(seed = 1) {
  let next = seed;
  return {
    bytes(size) {
      const value = Buffer.alloc(size, next);
      next += 1;
      return value;
    },
  };
}

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
    migrations: [projectPolicyMigration, projectOwnerBootstrapMigration],
    logger: { info() {} },
  });
  const repository = new LegacySequelizeProjectOwnerBootstrapRepository(
    database,
  );
  return {
    database,
    repository,
    service: new ProjectOwnerBootstrapService(
      repository,
      deterministicRandomSource(),
    ),
  };
}

test('normalizes an exact, bounded and live authenticated principal', () => {
  const value = principal();
  assert.deepEqual(normalizeAuthenticatedPrincipal(value), value);
  assert.throws(
    () => normalizeAuthenticatedPrincipal({ ...value, scopes: ['*'] }),
    /shape is invalid/,
  );
  assert.throws(
    () =>
      normalizeAuthenticatedPrincipal({
        ...value,
        authenticationId: 'auth with spaces',
      }),
    /authenticationId is invalid/,
  );
  assert.throws(
    () =>
      normalizeAuthenticatedPrincipal({
        ...value,
        expiresAtMs: value.authenticatedAtMs,
      }),
    /lifetime is invalid/,
  );
});

test('migration records versioned challenges and both bounded lookup indexes', async (t) => {
  const { database, service } = await setup(t);
  const issued = await service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  assert.match(issued.challengeId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAtMs, NOW + TTL_MS);

  const rows = await database
    .getQueryInterface()
    .select(null, PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].challenge_id, issued.challengeId);
  assert.match(rows[0].token_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].token_digest, issued.token);
  assert.equal(JSON.stringify(rows).includes(issued.token), false);
  assert.equal(rows[0].consumed_at_ms, null);
  assert.equal(
    (
      await database
        .getQueryInterface()
        .select(null, PROJECT_ROLE_BINDING_TABLE)
    ).length,
    0,
  );
  const indexes = new Set(
    (
      await database
        .getQueryInterface()
        .showIndex(PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE)
    ).map((index) => index.name),
  );
  assert.ok(indexes.has(PROJECT_OWNER_BOOTSTRAP_CHALLENGE_ID_INDEX));
  assert.ok(indexes.has(PROJECT_OWNER_BOOTSTRAP_CURRENT_INDEX));
});

test('only an active local-console bootstrap principal can issue', async (t) => {
  const { service } = await setup(t);
  for (const issuer of [
    principal(),
    localConsolePrincipal({ assurance: 'service' }),
    principal(
      { type: 'system', id: 'different-system' },
      { assurance: 'local_console' },
    ),
  ]) {
    await assert.rejects(
      service.issue({
        projectId: PROJECT_ID,
        issuer,
        nowMs: NOW,
        ttlMs: TTL_MS,
      }),
      ProjectOwnerBootstrapUnauthorizedError,
    );
  }
  await assert.rejects(
    service.issue({
      projectId: PROJECT_ID,
      issuer: localConsolePrincipal({ expiresAtMs: NOW }),
      nowMs: NOW,
      ttlMs: TTL_MS,
    }),
    AuthenticatedPrincipalExpiredError,
  );
  await assert.rejects(
    service.issue({
      projectId: PROJECT_ID,
      issuer: localConsolePrincipal(),
      nowMs: NOW,
      ttlMs: TTL_MS,
      subject: { type: 'user', id: 'injected-owner' },
    }),
    /request shape is invalid/,
  );
});

test('does not replace a live challenge and versions a replacement only after expiry', async (t) => {
  const { database, service } = await setup(t);
  const request = {
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  };
  const first = await service.issue(request);
  await assert.rejects(
    service.issue({ ...request, nowMs: NOW + 1 }),
    ProjectOwnerBootstrapChallengeActiveError,
  );
  const second = await service.issue({
    ...request,
    nowMs: NOW + TTL_MS,
  });
  assert.notEqual(second.challengeId, first.challengeId);
  const rows = await database.query(
    `SELECT version, challenge_id FROM "${PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE}" ORDER BY version`,
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(rows, [
    { version: 1, challenge_id: first.challengeId },
    { version: 2, challenge_id: second.challengeId },
  ]);
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: first.challengeId,
      token: first.token,
      principal: principal(),
      nowMs: NOW + TTL_MS + 1,
    }),
    ProjectOwnerBootstrapClaimRejectedError,
  );
});

test('claims one owner atomically and permits only exact idempotent replay', async (t) => {
  const { database, service } = await setup(t);
  const issued = await service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  const request = {
    projectId: PROJECT_ID,
    challengeId: issued.challengeId,
    token: issued.token,
    principal: principal(),
    nowMs: NOW + 1,
  };
  const claimed = await service.claim(request);
  assert.equal(claimed.status, 'claimed');
  assert.deepEqual(claimed.binding, {
    projectId: PROJECT_ID,
    subject: { type: 'user', id: 'owner-1' },
    version: 1,
    state: 'active',
    role: 'owner',
    mutationId: `owner-bootstrap:${issued.challengeId}`,
    changedBy: { type: 'system', id: 'owner-bootstrap' },
    createdAtMs: NOW + 1,
  });
  const replay = await service.claim({ ...request, nowMs: NOW + 2 });
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.binding, claimed.binding);

  const policyRepository = new LegacySequelizeProjectPolicyRepository(database);
  assert.deepEqual(
    (await policyRepository.resolve(PROJECT_ID, principal().subject)).binding,
    claimed.binding,
  );
  const challenge = (
    await database
      .getQueryInterface()
      .select(null, PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE)
  )[0];
  assert.equal(Number(challenge.consumed_at_ms), NOW + 1);
  assert.equal(challenge.claimed_subject_type, 'user');
  assert.equal(challenge.claimed_subject_id, 'owner-1');

  await assert.rejects(
    service.claim({
      ...request,
      principal: principal({ type: 'user', id: 'owner-2' }),
      nowMs: NOW + 2,
    }),
    ProjectOwnerBootstrapClaimRejectedError,
  );
});

test('rejects expired, malformed, mismatched and non-user claims without leaking the token', async (t) => {
  const { service } = await setup(t);
  const issued = await service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: Buffer.alloc(32, 99).toString('base64url'),
      principal: principal(),
      nowMs: NOW + 1,
    }),
    (error) => {
      assert.ok(error instanceof ProjectOwnerBootstrapClaimRejectedError);
      assert.equal(error.message.includes(issued.token), false);
      return true;
    },
  );
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal(),
      nowMs: NOW + TTL_MS,
    }),
    ProjectOwnerBootstrapClaimRejectedError,
  );
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal({ type: 'api_app', id: 'app-1' }),
      nowMs: NOW + 1,
    }),
    ProjectOwnerBootstrapUnauthorizedError,
  );
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: `${issued.token}x`,
      principal: principal(),
      nowMs: NOW + 1,
    }),
    (error) => {
      assert.equal(error.message.includes(issued.token), false);
      return true;
    },
  );
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal(),
      nowMs: NOW + 1,
      subject: { type: 'user', id: 'injected-owner' },
    }),
    /request shape is invalid/,
  );
});

test('refuses bootstrap whenever the Project already has any role binding', async (t) => {
  const first = await setup(t);
  await first.database.query(
    `INSERT INTO "${PROJECT_ROLE_BINDING_TABLE}"
       (project_id, subject_type, subject_id, version, state, role,
        mutation_id, changed_by_type, changed_by_id, created_at_ms)
     VALUES
       ('default', 'user', 'existing', 1, 'active', 'viewer',
        'existing-binding', 'system', 'owner-bootstrap', 1)`,
  );
  await assert.rejects(
    first.service.issue({
      projectId: PROJECT_ID,
      issuer: localConsolePrincipal(),
      nowMs: NOW,
      ttlMs: TTL_MS,
    }),
    ProjectOwnerBootstrapProjectNotPristineError,
  );

  const second = await setup(t);
  const issued = await second.service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  await second.database.query(
    `INSERT INTO "${PROJECT_ROLE_BINDING_TABLE}"
       (project_id, subject_type, subject_id, version, state, role,
        mutation_id, changed_by_type, changed_by_id, created_at_ms)
     VALUES
       ('default', 'user', 'existing', 1, 'active', 'viewer',
        'existing-binding', 'system', 'owner-bootstrap', 1)`,
  );
  await assert.rejects(
    second.service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal(),
      nowMs: NOW + 1,
    }),
    ProjectOwnerBootstrapProjectNotPristineError,
  );
});

test('fails closed for missing and archived Projects', async (t) => {
  const missing = await setup(t);
  await assert.rejects(
    missing.service.issue({
      projectId: 'missing',
      issuer: localConsolePrincipal(),
      nowMs: NOW,
      ttlMs: TTL_MS,
    }),
    ProjectOwnerBootstrapProjectNotFoundError,
  );

  const archived = await setup(t);
  const issued = await archived.service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  await archived.database.query(
    `UPDATE "${PROJECT_TABLE}" SET status = 'archived' WHERE id = 'default'`,
  );
  await assert.rejects(
    archived.service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal(),
      nowMs: NOW + 1,
    }),
    ProjectOwnerBootstrapProjectInactiveError,
  );
});

test('rolls back challenge consumption when owner binding insertion fails', async (t) => {
  const { database, service } = await setup(t);
  const issued = await service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  await database.query(
    `CREATE TRIGGER reject_bootstrap_owner
       BEFORE INSERT ON "${PROJECT_ROLE_BINDING_TABLE}"
       WHEN NEW.mutation_id LIKE 'owner-bootstrap:%'
       BEGIN
         SELECT RAISE(ABORT, 'forced bootstrap binding failure');
       END`,
  );
  const request = {
    projectId: PROJECT_ID,
    challengeId: issued.challengeId,
    token: issued.token,
    principal: principal(),
    nowMs: NOW + 1,
  };
  await assert.rejects(
    service.claim(request),
    ProjectOwnerBootstrapUnavailableError,
  );
  let challenge = (
    await database
      .getQueryInterface()
      .select(null, PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE)
  )[0];
  assert.equal(challenge.consumed_at_ms, null);
  assert.equal(
    (
      await database
        .getQueryInterface()
        .select(null, PROJECT_ROLE_BINDING_TABLE)
    ).length,
    0,
  );

  await database.query('DROP TRIGGER reject_bootstrap_owner');
  assert.equal((await service.claim(request)).status, 'claimed');
  challenge = (
    await database
      .getQueryInterface()
      .select(null, PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE)
  )[0];
  assert.equal(Number(challenge.consumed_at_ms), NOW + 1);
});

test('rolls back when SQLite silently ignores challenge consumption', async (t) => {
  const { database, service } = await setup(t);
  const issued = await service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  await database.query(
    `CREATE TRIGGER ignore_bootstrap_consumption
       BEFORE UPDATE ON "${PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE}"
       WHEN NEW.consumed_at_ms IS NOT NULL
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
  );
  await assert.rejects(
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal(),
      nowMs: NOW + 1,
    }),
    ProjectOwnerBootstrapUnavailableError,
  );
  const challenge = (
    await database
      .getQueryInterface()
      .select(null, PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE)
  )[0];
  assert.equal(challenge.consumed_at_ms, null);
  assert.equal(
    (
      await database
        .getQueryInterface()
        .select(null, PROJECT_ROLE_BINDING_TABLE)
    ).length,
    0,
  );
});

test('serializes claims from separate SQLite connections so exactly one owner wins', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-bootstrap-db-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'database.sqlite');
  const first = await setup(t, storage);
  const issued = await first.service.issue({
    projectId: PROJECT_ID,
    issuer: localConsolePrincipal(),
    nowMs: NOW,
    ttlMs: TTL_MS,
  });
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondService = new ProjectOwnerBootstrapService(
    new LegacySequelizeProjectOwnerBootstrapRepository(secondDatabase),
    deterministicRandomSource(50),
  );
  const claim = (service, ownerId) =>
    service.claim({
      projectId: PROJECT_ID,
      challengeId: issued.challengeId,
      token: issued.token,
      principal: principal({ type: 'user', id: ownerId }),
      nowMs: NOW + 1,
    });
  const results = await Promise.allSettled([
    claim(first.service, 'owner-a'),
    claim(secondService, 'owner-b'),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected.reason instanceof ProjectOwnerBootstrapClaimRejectedError);
  const bindings = await first.database
    .getQueryInterface()
    .select(null, PROJECT_ROLE_BINDING_TABLE);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].role, 'owner');
  assert.ok(['owner-a', 'owner-b'].includes(bindings[0].subject_id));
});

test('rejects non-SQLite bootstrap repositories', () => {
  assert.throws(
    () =>
      new LegacySequelizeProjectOwnerBootstrapRepository({
        getDialect() {
          return 'postgres';
        },
      }),
    /SQLite-only/,
  );
});
