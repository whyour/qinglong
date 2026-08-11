const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  InvalidModelPriceCatalogError,
  ModelPriceCatalogConflictError,
  ModelPriceCatalogUnavailableError,
  createModelPriceCatalogPublishCommand,
  createModelPriceCatalogTransitionCommand,
} = require('../dist/pricing/modelPriceCatalog.js');
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

async function fixture() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);
  await migrateLocalModelInvocationFeature(client);
  return {
    client,
    repository: new LocalModelPriceCatalogRepository(client),
  };
}

function publish(revision, mutationId, rate = 150_000) {
  return createModelPriceCatalogPublishCommand({
    provider: 'remote',
    model: 'model-a',
    priceRevision: revision,
    currency: 'USD',
    inputMicrosPerMillionTokens: rate,
    outputMicrosPerMillionTokens: rate * 4,
    mutationId,
    publishedByUserId: 'user-admin',
  });
}

function transition(head, action, revision, mutationId) {
  return createModelPriceCatalogTransitionCommand({
    provider: 'remote',
    model: 'model-a',
    expectedGeneration: head?.generation ?? 0,
    expectedHeadDigest: head?.headDigest ?? null,
    action,
    priceRevision: revision,
    mutationId,
    changedByUserId: 'user-admin',
  });
}

test('SQLite durable catalog publishes, activates, switches and revokes exactly', async () => {
  const { client, repository } = await fixture();
  const firstCommand = publish('price-1', 'publish-price-1');
  const first = await repository.publish(firstCommand);
  assert.equal(first.status, 'created');
  assert.deepEqual(await repository.publish(firstCommand), {
    status: 'existing',
    publication: first.publication,
  });
  assert.equal(
    await repository.resolve({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
    }),
    null,
  );

  const firstActivationCommand = transition(
    null,
    'activate',
    'price-1',
    'activate-price-1',
  );
  const firstActivation = await repository.transition(firstActivationCommand);
  assert.equal(firstActivation.status, 'created');
  assert.deepEqual(await repository.transition(firstActivationCommand), {
    status: 'existing',
    head: firstActivation.head,
  });
  assert.equal(
    (
      await repository.resolve({
        provider: 'remote',
        model: 'model-a',
        priceRevision: 'price-1',
      })
    ).catalogDigest,
    first.publication.entry.catalogDigest,
  );

  const second = await repository.publish(
    publish('price-2', 'publish-price-2', 200_000),
  );
  const secondActivation = await repository.transition(
    transition(firstActivation.head, 'activate', 'price-2', 'activate-price-2'),
  );
  assert.equal(
    await repository.resolve({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
    }),
    null,
  );
  assert.equal(
    (
      await repository.resolve({
        provider: 'remote',
        model: 'model-a',
        priceRevision: 'price-2',
      })
    ).catalogDigest,
    second.publication.entry.catalogDigest,
  );

  const revokeFirst = await repository.transition(
    transition(secondActivation.head, 'revoke', 'price-1', 'revoke-price-1'),
  );
  assert.equal(revokeFirst.head.activePriceRevision, 'price-2');
  assert.equal(revokeFirst.head.revokedPriceRevision, 'price-1');
  await assert.rejects(
    repository.transition(
      transition(revokeFirst.head, 'activate', 'price-1', 'reactivate-price-1'),
    ),
    ModelPriceCatalogConflictError,
  );

  const revokeSecond = await repository.transition(
    transition(revokeFirst.head, 'revoke', 'price-2', 'revoke-price-2'),
  );
  assert.equal(revokeSecond.head.activePriceRevision, null);
  assert.equal(
    await repository.resolve({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-2',
    }),
    null,
  );
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "ModelPriceCatalogHeads"`)
      .get().count,
    4,
  );
  client.close();
});

test('SQLite catalog gives one winner and rolls stale mutations back', async () => {
  const { client, repository } = await fixture();
  await repository.publish(publish('price-1', 'publish-price-1'));
  await repository.publish(publish('price-2', 'publish-price-2'));
  const first = await repository.transition(
    transition(null, 'activate', 'price-1', 'activate-price-1'),
  );
  const competing = await Promise.allSettled([
    repository.transition(
      transition(first.head, 'activate', 'price-2', 'activate-price-2-a'),
    ),
    repository.transition(
      transition(first.head, 'deactivate', null, 'deactivate-price-1-b'),
    ),
  ]);
  assert.equal(
    competing.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    competing.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof ModelPriceCatalogConflictError,
    ).length,
    1,
  );
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "ModelPriceCatalogHeads"`)
      .get().count,
    2,
  );
  client.close();
});

test('SQLite catalog fails closed on corrupted durable JSON', async () => {
  const { client, repository } = await fixture();
  await repository.publish(publish('price-1', 'publish-price-1'));
  client.exec(`
    PRAGMA ignore_check_constraints = ON;
    UPDATE "ModelPriceCatalogPublications"
       SET publication_json = '{}'
     WHERE price_revision = 'price-1';
    PRAGMA ignore_check_constraints = OFF;
  `);
  await assert.rejects(
    repository.findPublication({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
    }),
    ModelPriceCatalogUnavailableError,
  );
  client.close();
});

test('SQLite catalog validates and preserves resolver cancellation', async () => {
  const { client, repository } = await fixture();
  await assert.rejects(
    repository.resolve({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
      signal: {},
    }),
    InvalidModelPriceCatalogError,
  );

  const controller = new AbortController();
  const reason = new Error('catalog lookup cancelled');
  const resolution = repository.resolve({
    provider: 'remote',
    model: 'model-a',
    priceRevision: 'price-1',
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(resolution, reason);
  client.close();
});
