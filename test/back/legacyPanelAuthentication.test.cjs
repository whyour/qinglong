require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  IDENTITY_AUTHENTICATION_BINDING_CURRENT_INDEX,
  IDENTITY_AUTHENTICATION_BINDING_SUBJECT_INDEX,
  IDENTITY_AUTHENTICATION_BINDING_TABLE,
  IDENTITY_SUBJECT_STATUS_INDEX,
  IDENTITY_SUBJECT_TABLE,
  identityDirectoryMigration,
} = require('../../back/migrations/0019-identity-directory');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacyAuthInfoSessionSource,
  LegacyPanelSessionUnavailableError,
  MAX_LEGACY_PANEL_TOKENS_PER_PLATFORM,
} = require('../../back/runtime/adapters/authentication/legacyAuthInfoSessionSource');
const {
  LegacySequelizeIdentityDirectoryRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/identityDirectoryRepository');
const {
  LegacyPanelAuthenticationRejectedError,
  LegacyPanelAuthenticationService,
  LegacyPanelAuthenticationUnavailableError,
} = require('../../back/runtime/application/legacyPanelAuthenticationService');
const {
  IdentityDirectoryUnavailableError,
  LEGACY_PANEL_IDENTITY_PROVIDER,
  LEGACY_PANEL_PROVIDER_SUBJECT,
  LEGACY_PRIMARY_USER_SUBJECT_ID,
} = require('../../back/runtime/domain/identityDirectory');

const SECRET = 'test-only-legacy-jwt-secret';
const ISSUED_AT_SECONDS = 100;
const EXPIRES_AT_SECONDS = 200;
const NOW_MS = 150_000;

function signToken(
  payload = {
    data: 'legacy-session-random-data',
    iat: ISSUED_AT_SECONDS,
    exp: EXPIRES_AT_SECONDS,
  },
  algorithm = 'HS384',
  secret = SECRET,
) {
  return jwt.sign(payload, secret, { algorithm });
}

async function setup(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [identityDirectoryMigration],
    logger: { info() {} },
  });
  return {
    database,
    directory: new LegacySequelizeIdentityDirectoryRepository(database),
  };
}

function sessionSource(snapshot) {
  return new LegacyAuthInfoSessionSource(async () => snapshot);
}

function authentication(directory, snapshot, secret = SECRET) {
  return new LegacyPanelAuthenticationService(
    directory,
    sessionSource(snapshot),
    secret,
  );
}

test('migration creates a stable singleton identity without copying legacy credentials', async (t) => {
  const { database, directory } = await setup(t);
  const subjects = await database
    .getQueryInterface()
    .select(null, IDENTITY_SUBJECT_TABLE);
  const bindings = await database
    .getQueryInterface()
    .select(null, IDENTITY_AUTHENTICATION_BINDING_TABLE);
  assert.deepEqual(subjects, [
    {
      id: LEGACY_PRIMARY_USER_SUBJECT_ID,
      type: 'user',
      status: 'active',
      version: 1,
      created_at_ms: 0,
      updated_at_ms: 0,
    },
  ]);
  assert.deepEqual(bindings, [
    {
      provider: LEGACY_PANEL_IDENTITY_PROVIDER,
      provider_subject: LEGACY_PANEL_PROVIDER_SUBJECT,
      version: 1,
      state: 'active',
      subject_id: LEGACY_PRIMARY_USER_SUBJECT_ID,
      created_at_ms: 0,
    },
  ]);
  const persisted = JSON.stringify({ subjects, bindings });
  assert.equal(persisted.includes('username'), false);
  assert.equal(persisted.includes('password'), false);
  assert.equal(persisted.includes('token'), false);
  assert.deepEqual(
    await directory.resolveAuthenticationSubject(
      LEGACY_PANEL_IDENTITY_PROVIDER,
      LEGACY_PANEL_PROVIDER_SUBJECT,
    ),
    { type: 'user', id: LEGACY_PRIMARY_USER_SUBJECT_ID },
  );

  const subjectIndexes = new Set(
    (await database.getQueryInterface().showIndex(IDENTITY_SUBJECT_TABLE)).map(
      (index) => index.name,
    ),
  );
  const bindingIndexes = new Set(
    (
      await database
        .getQueryInterface()
        .showIndex(IDENTITY_AUTHENTICATION_BINDING_TABLE)
    ).map((index) => index.name),
  );
  assert.ok(subjectIndexes.has(IDENTITY_SUBJECT_STATUS_INDEX));
  assert.ok(bindingIndexes.has(IDENTITY_AUTHENTICATION_BINDING_CURRENT_INDEX));
  assert.ok(bindingIndexes.has(IDENTITY_AUTHENTICATION_BINDING_SUBJECT_INDEX));
});

test('authenticates a current HS384 legacy session as one stable single-factor user', async (t) => {
  const { directory } = await setup(t);
  const token = signToken();
  const service = authentication(directory, {
    token: '',
    tokens: {
      desktop: [
        {
          value: token,
          timestamp: 123,
          platform: 'desktop',
        },
      ],
    },
    username: 'a-display-name-that-may-change',
    twoFactorActivated: true,
  });
  assert.deepEqual(
    await service.authenticate({ token, platform: 'desktop', nowMs: NOW_MS }),
    {
      subject: { type: 'user', id: LEGACY_PRIMARY_USER_SUBJECT_ID },
      authenticationId: `legacy_panel:${createHash('sha256')
        .update(token, 'utf8')
        .digest('hex')}`,
      authenticatedAtMs: ISSUED_AT_SECONDS * 1000,
      expiresAtMs: EXPIRES_AT_SECONDS * 1000,
      assurance: 'single_factor',
    },
  );
});

test('supports only the bounded legacy primary, string and TokenInfo list formats', async () => {
  const token = signToken();
  assert.equal(await sessionSource({ token }).isActive(token, 'mobile'), true);
  assert.equal(
    await sessionSource({ tokens: { desktop: token } }).isActive(
      token,
      'desktop',
    ),
    true,
  );
  assert.equal(
    await sessionSource({
      tokens: { desktop: [{ value: token }] },
    }).isActive(token, 'desktop'),
    true,
  );
  assert.equal(
    await sessionSource({ tokens: { mobile: [{ value: token }] } }).isActive(
      token,
      'desktop',
    ),
    false,
  );
  await assert.rejects(
    sessionSource({
      tokens: {
        desktop: Array.from(
          { length: MAX_LEGACY_PANEL_TOKENS_PER_PLATFORM + 1 },
          () => ({ value: token }),
        ),
      },
    }).isActive(token, 'desktop'),
    LegacyPanelSessionUnavailableError,
  );
  await assert.rejects(
    sessionSource({ tokens: { desktop: [{}] } }).isActive(token, 'desktop'),
    LegacyPanelSessionUnavailableError,
  );
});

test('rejects logout, platform drift, expiry, wrong signature and wrong algorithm', async (t) => {
  const { directory } = await setup(t);
  const token = signToken();
  for (const [service, request] of [
    [authentication(directory, { tokens: {} }), {}],
    [
      authentication(directory, {
        tokens: { mobile: [{ value: token }] },
      }),
      {},
    ],
    [
      authentication(directory, {
        tokens: { desktop: [{ value: token }] },
      }),
      { nowMs: EXPIRES_AT_SECONDS * 1000 },
    ],
    [
      authentication(
        directory,
        { tokens: { desktop: [{ value: token }] } },
        'different-secret',
      ),
      {},
    ],
    [
      authentication(directory, {
        tokens: { desktop: [{ value: signToken(undefined, 'HS256') }] },
      }),
      { token: signToken(undefined, 'HS256') },
    ],
  ]) {
    await assert.rejects(
      service.authenticate({
        token,
        platform: 'desktop',
        nowMs: NOW_MS,
        ...request,
      }),
      LegacyPanelAuthenticationRejectedError,
    );
  }
});

test('rejects extensible JWTs and request-supplied subjects before identity lookup', async (t) => {
  const { directory } = await setup(t);
  let sessionReads = 0;
  const extraPayloadToken = signToken({
    data: 'legacy-session-random-data',
    iat: ISSUED_AT_SECONDS,
    exp: EXPIRES_AT_SECONDS,
    subject: 'attacker',
  });
  const service = new LegacyPanelAuthenticationService(
    directory,
    {
      async isActive() {
        sessionReads += 1;
        return true;
      },
    },
    SECRET,
  );
  await assert.rejects(
    service.authenticate({
      token: extraPayloadToken,
      platform: 'desktop',
      nowMs: NOW_MS,
    }),
    LegacyPanelAuthenticationRejectedError,
  );
  assert.equal(sessionReads, 0);
  const futureIssuedToken = signToken({
    data: 'legacy-session-random-data',
    iat: ISSUED_AT_SECONDS + 60,
    exp: EXPIRES_AT_SECONDS,
  });
  await assert.rejects(
    service.authenticate({
      token: futureIssuedToken,
      platform: 'desktop',
      nowMs: NOW_MS,
    }),
    LegacyPanelAuthenticationRejectedError,
  );
  assert.equal(sessionReads, 0);
  await assert.rejects(
    service.authenticate({
      token: signToken(),
      platform: 'desktop',
      nowMs: NOW_MS,
      subject: { type: 'user', id: 'attacker' },
    }),
    /request shape is invalid/,
  );
  assert.equal(sessionReads, 0);
});

test('revocation and subject disablement remove legacy authentication authority', async (t) => {
  const revoked = await setup(t);
  await revoked.database
    .getQueryInterface()
    .bulkInsert(IDENTITY_AUTHENTICATION_BINDING_TABLE, [
      {
        provider: LEGACY_PANEL_IDENTITY_PROVIDER,
        provider_subject: LEGACY_PANEL_PROVIDER_SUBJECT,
        version: 2,
        state: 'revoked',
        subject_id: LEGACY_PRIMARY_USER_SUBJECT_ID,
        created_at_ms: NOW_MS,
      },
    ]);
  assert.equal(
    await revoked.directory.resolveAuthenticationSubject(
      LEGACY_PANEL_IDENTITY_PROVIDER,
      LEGACY_PANEL_PROVIDER_SUBJECT,
    ),
    null,
  );

  const disabled = await setup(t);
  await disabled.database
    .getQueryInterface()
    .bulkUpdate(
      IDENTITY_SUBJECT_TABLE,
      { status: 'disabled', version: 2, updated_at_ms: NOW_MS },
      { id: LEGACY_PRIMARY_USER_SUBJECT_ID },
    );
  const token = signToken();
  await assert.rejects(
    authentication(disabled.directory, {
      tokens: { desktop: [{ value: token }] },
    }).authenticate({ token, platform: 'desktop', nowMs: NOW_MS }),
    LegacyPanelAuthenticationRejectedError,
  );
});

test('fails closed on corrupt identity storage and session source failures', async (t) => {
  const { database, directory } = await setup(t);
  await database.query('PRAGMA ignore_check_constraints = ON');
  await database
    .getQueryInterface()
    .bulkUpdate(
      IDENTITY_AUTHENTICATION_BINDING_TABLE,
      { state: 'corrupt' },
      { provider: LEGACY_PANEL_IDENTITY_PROVIDER },
    );
  await assert.rejects(
    directory.resolveAuthenticationSubject(
      LEGACY_PANEL_IDENTITY_PROVIDER,
      LEGACY_PANEL_PROVIDER_SUBJECT,
    ),
    IdentityDirectoryUnavailableError,
  );

  const orphaned = await setup(t);
  await orphaned.database.query('PRAGMA foreign_keys = OFF');
  await orphaned.database
    .getQueryInterface()
    .bulkDelete(IDENTITY_SUBJECT_TABLE, {
      id: LEGACY_PRIMARY_USER_SUBJECT_ID,
    });
  await assert.rejects(
    orphaned.directory.resolveAuthenticationSubject(
      LEGACY_PANEL_IDENTITY_PROVIDER,
      LEGACY_PANEL_PROVIDER_SUBJECT,
    ),
    IdentityDirectoryUnavailableError,
  );

  const token = signToken();
  const service = new LegacyPanelAuthenticationService(
    directory,
    {
      async isActive() {
        throw new Error(`must not leak ${token}`);
      },
    },
    SECRET,
  );
  await assert.rejects(
    service.authenticate({ token, platform: 'desktop', nowMs: NOW_MS }),
    (error) => {
      assert.ok(error instanceof LegacyPanelAuthenticationUnavailableError);
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});

test('rejects non-SQLite identity directory repositories', () => {
  assert.throws(
    () =>
      new LegacySequelizeIdentityDirectoryRepository({
        getDialect() {
          return 'postgres';
        },
      }),
    /SQLite-only/,
  );
});
