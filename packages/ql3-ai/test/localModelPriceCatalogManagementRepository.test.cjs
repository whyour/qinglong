const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ModelPriceCatalogConflictError,
  createModelPriceCatalogPublishCommand,
  createModelPriceCatalogTransitionCommand,
} = require('../dist/pricing/modelPriceCatalog.js');
const {
  ModelPriceCatalogManagementSeparationOfDutyError,
  createModelPriceCatalogAuthorizationCommand,
  createModelPriceCatalogManagementService,
  createModelPriceCatalogPolicyDecision,
} = require('../dist/pricing/modelPriceCatalogManagement.js');
const {
  LocalModelPriceCatalogRepository,
} = require('../dist/pricing/storage/localModelPriceCatalogRepository.js');
const {
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');

function createMainSqliteContract(client) {
  client.exec(`
    CREATE TABLE "QingLong3SchemaMigrations" (
      migration_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      dialect TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "Runs" (id TEXT PRIMARY KEY);
    CREATE TABLE "RunEvents" (id TEXT PRIMARY KEY);
    CREATE TABLE "StepRuns" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      UNIQUE (run_id, id)
    );
    CREATE TABLE "StepRunMutations" (mutation_id TEXT PRIMARY KEY);
  `);
}

async function fixture(decisionMode = 'human_confirmation') {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);
  await migrateLocalModelInvocationFeature(client);
  const repository = new LocalModelPriceCatalogRepository(client);
  const now = Date.now();
  const service = createModelPriceCatalogManagementService(repository, {
    decisionMode,
    authorizer: {
      async authorize() {
        return createModelPriceCatalogPolicyDecision({
          effect: 'allow',
          revision: 'platform-policy-1',
          reasons: ['catalog_operator'],
        });
      },
    },
    now: () => now,
  });
  return { client, repository, service, now };
}

function principal(userId, now) {
  return {
    subject: { type: 'user', id: userId },
    authenticationId: `auth-${userId}`,
    authenticatedAtMs: now - 1_000,
    expiresAtMs: now + 60_000,
    assurance: 'multi_factor',
  };
}

function publication(userId, now, overrides = {}) {
  return {
    authorizationId: 'authorize-publish-1',
    requestId: 'request-publish-1',
    mutationId: 'publish-price-1',
    provider: 'remote',
    model: 'model-a',
    principal: principal(userId, now),
    priceRevision: 'price-1',
    currency: 'USD',
    inputMicrosPerMillionTokens: 150_000,
    outputMicrosPerMillionTokens: 600_000,
    ...overrides,
  };
}

function activation(userId, now, overrides = {}) {
  return {
    authorizationId: 'authorize-activate-1',
    requestId: 'request-activate-1',
    mutationId: 'activate-price-1',
    provider: 'remote',
    model: 'model-a',
    principal: principal(userId, now),
    expectedGeneration: 0,
    expectedHeadDigest: null,
    action: 'activate',
    priceRevision: 'price-1',
    ...overrides,
  };
}

test('SQLite atomically commits catalog mutations with exact authorization facts', async () => {
  const { client, repository, service, now } = await fixture();
  const published = await service.publish(publication('owner', now));
  const replayed = await service.publish(publication('owner', now));
  assert.equal(published.status, 'created');
  assert.equal(replayed.status, 'existing');
  assert.deepEqual(replayed, {
    status: 'existing',
    publication: published.publication,
    authorization: published.authorization,
  });

  const activated = await service.transition(activation('owner', now));
  assert.equal(activated.status, 'created');
  assert.equal(activated.head.activePriceRevision, 'price-1');
  assert.deepEqual(
    await repository.findAuthorization('authorize-activate-1'),
    activated.authorization,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
           (SELECT count(*) FROM "ModelPriceCatalogPublications") AS publications,
           (SELECT count(*) FROM "ModelPriceCatalogHeads") AS heads,
           (SELECT count(*) FROM "ModelPriceCatalogAuthorizations") AS authorizations`,
        )
        .get(),
    },
    { publications: 1, heads: 1, authorizations: 2 },
  );
  assert.equal(client.prepare('PRAGMA foreign_key_check').all().length, 0);

  await assert.rejects(
    service.publish(
      publication('owner', now, {
        authorizationId: 'authorize-publish-drift',
      }),
    ),
    ModelPriceCatalogConflictError,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "ModelPriceCatalogAuthorizations"`,
      )
      .get().count,
    2,
  );
  client.close();
});

test('SQLite replay accepts fresh reauthentication but preserves the first authorization fact', async () => {
  const { client, repository, service, now } = await fixture();
  const created = await service.publish(publication('owner', now));
  const freshService = createModelPriceCatalogManagementService(repository, {
    decisionMode: 'human_confirmation',
    authorizer: {
      async authorize() {
        return createModelPriceCatalogPolicyDecision({
          effect: 'allow',
          revision: 'platform-policy-1',
          reasons: ['catalog_operator'],
        });
      },
    },
    now: () => now + 1_000,
  });

  const replayed = await freshService.publish(
    publication('owner', now + 1_000),
  );
  assert.equal(replayed.status, 'existing');
  assert.deepEqual(replayed.authorization, created.authorization);
  await assert.rejects(
    freshService.publish(
      publication('owner', now + 1_000, {
        principal: {
          ...principal('owner', now + 1_000),
          authenticationId: 'auth-different-proof',
        },
      }),
    ),
    ModelPriceCatalogConflictError,
  );
  client.close();
});

test('SQLite authorization fence hook runs inside the catalog transaction before mutation', async () => {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);
  await migrateLocalModelInvocationFeature(client);
  let checked = 0;
  const repository = new LocalModelPriceCatalogRepository(client, {
    beforeAuthorizedMutation() {
      checked += 1;
      const error = new Error('credential fence rejected');
      error.code = 'TEST_CREDENTIAL_FENCE_REJECTED';
      throw error;
    },
  });
  const now = Date.now();
  const service = createModelPriceCatalogManagementService(repository, {
    decisionMode: 'human_confirmation',
    authorizer: {
      async authorize() {
        return createModelPriceCatalogPolicyDecision({
          effect: 'allow',
          revision: 'platform-policy-1',
          reasons: ['catalog_operator'],
        });
      },
    },
    now: () => now,
  });

  await assert.rejects(service.publish(publication('owner', now)), {
    code: 'MODEL_PRICE_CATALOG_UNAVAILABLE',
  });
  assert.equal(checked, 1);
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
             (SELECT count(*) FROM "ModelPriceCatalogPublications") AS publications,
             (SELECT count(*) FROM "ModelPriceCatalogAuthorizations") AS authorizations`,
        )
        .get(),
    },
    { publications: 0, authorizations: 0 },
  );
  assert.equal(client.isTransaction, false);
  client.close();
});

test('authorized activation rejects legacy raw publication without evidence', async () => {
  const { client, repository, service, now } = await fixture();
  await repository.publish(
    createModelPriceCatalogPublishCommand({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
      currency: 'USD',
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
      mutationId: 'legacy-publish-price-1',
      publishedByUserId: 'owner',
    }),
  );

  await assert.rejects(
    service.transition(activation('owner', now)),
    ModelPriceCatalogConflictError,
  );
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "ModelPriceCatalogHeads"`)
      .get().count,
    0,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "ModelPriceCatalogAuthorizations"`,
      )
      .get().count,
    0,
  );
  client.close();
});

test('SQLite enforces separation of duty again inside the catalog transaction', async () => {
  const { client, repository, service, now } = await fixture(
    'separation_of_duty',
  );
  await service.publish(publication('publisher', now));
  await assert.rejects(
    service.transition(activation('publisher', now)),
    ModelPriceCatalogManagementSeparationOfDutyError,
  );

  const directCommand = createModelPriceCatalogTransitionCommand({
    provider: 'remote',
    model: 'model-a',
    expectedGeneration: 0,
    expectedHeadDigest: null,
    action: 'activate',
    priceRevision: 'price-1',
    mutationId: 'direct-activate-price-1',
    changedByUserId: 'publisher',
  });
  const directAuthorization = createModelPriceCatalogAuthorizationCommand({
    authorizationId: 'direct-same-user',
    requestId: 'direct-same-user-request',
    operation: 'activate',
    provider: 'remote',
    model: 'model-a',
    priceRevision: 'price-1',
    catalogCommandDigest: directCommand.commandDigest,
    principal: principal('publisher', now),
    policy: createModelPriceCatalogPolicyDecision({
      effect: 'allow',
      revision: 'platform-policy-1',
      reasons: ['catalog_operator'],
    }),
    decisionMode: 'separation_of_duty',
  });
  await assert.rejects(
    repository.transitionAuthorized(directCommand, directAuthorization),
    ModelPriceCatalogConflictError,
  );

  const reviewed = await service.transition(activation('reviewer', now));
  assert.equal(reviewed.head.activePriceRevision, 'price-1');
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "ModelPriceCatalogHeads"`)
      .get().count,
    1,
  );
  assert.equal(
    await repository
      .findCurrent('remote', 'model-a')
      .then((head) => head.activePriceRevision),
    'price-1',
  );
  client.close();
});
