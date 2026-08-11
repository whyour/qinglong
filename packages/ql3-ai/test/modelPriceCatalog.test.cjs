const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InvalidModelPriceCatalogError,
  MODEL_PRICE_CATALOG_HEAD_SCHEMA,
  MODEL_PRICE_CATALOG_PUBLICATION_SCHEMA,
  createModelPriceCatalogHead,
  createModelPriceCatalogPublication,
  createModelPriceCatalogPublishCommand,
  createModelPriceCatalogTransitionCommand,
  normalizeModelPriceCatalogHead,
  normalizeModelPriceCatalogPublication,
  normalizeModelPriceCatalogPublishCommand,
  normalizeModelPriceCatalogTransitionCommand,
} = require('../dist/pricing/modelPriceCatalog.js');

const NOW = 1_000_000;

function publishCommand(overrides = {}) {
  return createModelPriceCatalogPublishCommand({
    provider: 'remote',
    model: 'model-a',
    priceRevision: 'price-1',
    currency: 'USD',
    inputMicrosPerMillionTokens: 150_000,
    outputMicrosPerMillionTokens: 600_000,
    mutationId: 'publish-price-1',
    publishedByUserId: 'user-admin',
    ...overrides,
  });
}

function transitionCommand(overrides = {}) {
  return createModelPriceCatalogTransitionCommand({
    provider: 'remote',
    model: 'model-a',
    expectedGeneration: 0,
    expectedHeadDigest: null,
    action: 'activate',
    priceRevision: 'price-1',
    mutationId: 'activate-price-1',
    changedByUserId: 'user-admin',
    ...overrides,
  });
}

test('publication binds a database time, exact price and User mutation', () => {
  const command = publishCommand();
  const publication = createModelPriceCatalogPublication(command, NOW);

  assert.deepEqual(normalizeModelPriceCatalogPublishCommand(command), command);
  assert.equal(publication.schema, MODEL_PRICE_CATALOG_PUBLICATION_SCHEMA);
  assert.equal(publication.entry.publishedAtMs, NOW);
  assert.equal(publication.publishedByUserId, 'user-admin');
  assert.deepEqual(
    normalizeModelPriceCatalogPublication(publication),
    publication,
  );
  assert.throws(
    () =>
      normalizeModelPriceCatalogPublishCommand({
        ...command,
        inputMicrosPerMillionTokens: command.inputMicrosPerMillionTokens + 1,
      }),
    InvalidModelPriceCatalogError,
  );
});

test('head transitions activate, deactivate and permanently revoke revisions', () => {
  const publication = createModelPriceCatalogPublication(publishCommand(), NOW);
  const activate = transitionCommand();
  const active = createModelPriceCatalogHead(
    null,
    activate,
    publication,
    false,
    NOW + 1,
  );
  assert.deepEqual(
    normalizeModelPriceCatalogTransitionCommand(activate),
    activate,
  );
  assert.equal(active.schema, MODEL_PRICE_CATALOG_HEAD_SCHEMA);
  assert.equal(active.generation, 1);
  assert.equal(active.activePriceRevision, 'price-1');
  assert.deepEqual(normalizeModelPriceCatalogHead(active), active);
  assert.throws(
    () =>
      normalizeModelPriceCatalogHead({
        ...active,
        action: 'deactivate',
      }),
    InvalidModelPriceCatalogError,
  );

  const deactivate = transitionCommand({
    expectedGeneration: 1,
    expectedHeadDigest: active.headDigest,
    action: 'deactivate',
    priceRevision: null,
    mutationId: 'deactivate-price-1',
  });
  const inactive = createModelPriceCatalogHead(
    active,
    deactivate,
    null,
    false,
    NOW + 2,
  );
  assert.equal(inactive.activePriceRevision, null);
  assert.throws(
    () =>
      normalizeModelPriceCatalogHead({
        ...inactive,
        action: 'activate',
      }),
    InvalidModelPriceCatalogError,
  );

  const revoke = transitionCommand({
    expectedGeneration: 2,
    expectedHeadDigest: inactive.headDigest,
    action: 'revoke',
    mutationId: 'revoke-price-1',
  });
  const revoked = createModelPriceCatalogHead(
    inactive,
    revoke,
    publication,
    false,
    NOW + 3,
  );
  assert.equal(revoked.activePriceRevision, null);
  assert.equal(revoked.revokedPriceRevision, 'price-1');
  assert.deepEqual(normalizeModelPriceCatalogHead(revoked), revoked);

  const reactivate = transitionCommand({
    expectedGeneration: 3,
    expectedHeadDigest: revoked.headDigest,
    mutationId: 'reactivate-price-1',
  });
  assert.throws(
    () =>
      createModelPriceCatalogHead(
        revoked,
        reactivate,
        publication,
        true,
        NOW + 4,
      ),
    InvalidModelPriceCatalogError,
  );
});

test('transition fences reject stale, detached and no-op changes', () => {
  const publication = createModelPriceCatalogPublication(publishCommand(), NOW);
  const active = createModelPriceCatalogHead(
    null,
    transitionCommand(),
    publication,
    false,
    NOW + 1,
  );

  assert.throws(
    () =>
      createModelPriceCatalogHead(
        active,
        transitionCommand({ mutationId: 'stale-activation' }),
        publication,
        false,
        NOW + 2,
      ),
    InvalidModelPriceCatalogError,
  );
  assert.throws(
    () =>
      createModelPriceCatalogHead(
        active,
        transitionCommand({
          expectedGeneration: 1,
          expectedHeadDigest: active.headDigest,
          mutationId: 'duplicate-activation',
        }),
        publication,
        false,
        NOW + 2,
      ),
    InvalidModelPriceCatalogError,
  );
  assert.throws(
    () =>
      createModelPriceCatalogTransitionCommand({
        provider: 'remote',
        model: 'model-a',
        expectedGeneration: 0,
        expectedHeadDigest: null,
        action: 'deactivate',
        priceRevision: 'price-1',
        mutationId: 'invalid-deactivate',
        changedByUserId: 'user-admin',
      }),
    InvalidModelPriceCatalogError,
  );
});
