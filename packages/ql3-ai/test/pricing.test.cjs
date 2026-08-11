const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InvalidModelPricingError,
  MODEL_INVOCATION_PRICE_QUOTE_SCHEMA,
  MODEL_INVOCATION_PRICE_SETTLEMENT_SCHEMA,
  MODEL_PRICE_CATALOG_ENTRY_SCHEMA,
  StaticModelPriceCatalog,
  createModelInvocationPriceQuote,
  createModelInvocationPriceSettlement,
  createModelPriceCatalogEntry,
  normalizeModelInvocationPriceQuote,
  normalizeModelInvocationPriceSettlement,
  normalizeModelPriceCatalogEntry,
  priceModelUsage,
} = require('../dist/pricing/pricing.js');

const {
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
} = require('../dist/model-invocation/modelInvocation.js');
const {
  createStepRunRecord,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');

const NOW = 1_000_000;

function price(overrides = {}) {
  return createModelPriceCatalogEntry({
    provider: 'remote',
    model: 'model-a',
    priceRevision: 'price-2026-07',
    currency: 'USD',
    inputMicrosPerMillionTokens: 150_000,
    outputMicrosPerMillionTokens: 600_000,
    publishedAtMs: NOW - 1,
    ...overrides,
  });
}

function audit(phase, overrides = {}) {
  return {
    phase,
    projectId: 'project-a',
    runId: 'run-a',
    stepRunId: 'step-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    provider: 'remote',
    model: 'model-a',
    policyRevision: 'policy-1',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    deadlineAtMs: NOW + 10_000,
    inputBytes: 128,
    maxOutputTokens: 64,
    outputBytes: 0,
    usage: null,
    errorCode: null,
    occurredAtMs: NOW,
    ...overrides,
  };
}

function commands(usage) {
  const failed = usage === null;
  const ready = createStepRunRecord({
    id: 'step-a',
    runId: 'run-a',
    stepKey: 'model',
    kind: 'model',
    definitionRef: 'prompt:a@1',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:a',
    mutationId: 'create-step-a',
    createdAtMs: NOW - 1,
  });
  const startIdentity = createModelInvocationMutationIdentity(
    'request-a',
    'start',
  );
  const start = createModelInvocationStartCommand(
    audit('admitted'),
    transitionStepRunMutation(
      ready,
      {
        expectedVersion: ready.version,
        expectedDigest: ready.stepRunDigest,
        mutationId: startIdentity.mutationId,
        to: 'running',
        atMs: NOW,
      },
      {
        expectedRunVersion: 1,
        expectedRunEventSequence: 1,
        eventId: startIdentity.eventId,
        dedupeKey: startIdentity.dedupeKey,
        actor: { type: 'executor', id: 'model-gateway' },
      },
    ),
  );
  const completionIdentity = createModelInvocationMutationIdentity(
    'request-a',
    'completion',
  );
  const completion = createModelInvocationCompletionCommand(
    start.start,
    audit(failed ? 'failed' : 'completed', {
      outputBytes: failed ? 0 : 12,
      usage,
      errorCode: failed ? 'MODEL_PROVIDER_FAILED' : null,
      occurredAtMs: NOW + 25,
    }),
    transitionStepRunMutation(
      start.stepRunMutation.stepRun,
      {
        expectedVersion: start.start.startedStepRunVersion,
        expectedDigest: start.start.startedStepRunDigest,
        mutationId: completionIdentity.mutationId,
        to: failed ? 'failed' : 'succeeded',
        ...(failed
          ? {
              resultCode: 'model_provider_failed',
              errorSummary: 'Model invocation failed',
            }
          : { outputRef: 'model-invocation:request-a' }),
        atMs: NOW + 25,
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: completionIdentity.eventId,
        dedupeKey: completionIdentity.dedupeKey,
        actor: { type: 'executor', id: 'model-gateway' },
      },
    ),
  );
  return { start, completion };
}

test('catalog keeps exact immutable provider/model/revision identities', async () => {
  const entry = price();
  const catalog = new StaticModelPriceCatalog([entry]);

  assert.equal(entry.schema, MODEL_PRICE_CATALOG_ENTRY_SCHEMA);
  assert.deepEqual(normalizeModelPriceCatalogEntry(entry), entry);
  assert.deepEqual(
    await catalog.resolve({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-2026-07',
    }),
    entry,
  );
  assert.equal(
    await catalog.resolve({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-older',
    }),
    null,
  );
  assert.throws(
    () => new StaticModelPriceCatalog([entry, entry]),
    InvalidModelPricingError,
  );
});

test('quote reserves the worst valid token allocation without overflow', () => {
  const quote = createModelInvocationPriceQuote(price(), {
    invocationId: 'request-a',
    projectId: 'project-a',
    modelPolicyRevision: 'policy-1',
    maxTotalTokens: 256,
    maxOutputTokens: 64,
  });

  assert.equal(quote.schema, MODEL_INVOCATION_PRICE_QUOTE_SCHEMA);
  assert.equal(quote.reservedCostMicros, 68);
  assert.deepEqual(normalizeModelInvocationPriceQuote(quote), quote);
  assert.equal(Object.isFrozen(quote), true);
});

test('settlement deterministically prices exact usage and ignores provider cost', () => {
  const quote = createModelInvocationPriceQuote(price(), {
    invocationId: 'request-a',
    projectId: 'project-a',
    modelPolicyRevision: 'policy-1',
    maxTotalTokens: 256,
    maxOutputTokens: 64,
  });
  const providerUsage = {
    inputTokens: 5,
    outputTokens: 2,
    totalTokens: 7,
    costMicros: 99_999,
  };
  const canonicalUsage = priceModelUsage(quote, providerUsage);
  const { completion } = commands(canonicalUsage);
  const settlement = createModelInvocationPriceSettlement(
    quote,
    completion.completion,
  );

  assert.ok(settlement);
  assert.equal(canonicalUsage.costMicros, 3);
  assert.equal(settlement.schema, MODEL_INVOCATION_PRICE_SETTLEMENT_SCHEMA);
  assert.equal(settlement.costMicros, 3);
  assert.deepEqual(
    normalizeModelInvocationPriceSettlement(
      settlement,
      quote,
      completion.completion,
    ),
    settlement,
  );
});

test('unknown usage remains unpriced and quote tampering fails closed', () => {
  const quote = createModelInvocationPriceQuote(price(), {
    invocationId: 'request-a',
    projectId: 'project-a',
    modelPolicyRevision: 'policy-1',
    maxTotalTokens: 256,
    maxOutputTokens: 64,
  });
  const failed = commands(null);

  assert.equal(
    createModelInvocationPriceSettlement(quote, failed.completion.completion),
    null,
  );
  assert.throws(
    () =>
      normalizeModelInvocationPriceQuote({
        ...quote,
        reservedCostMicros: quote.reservedCostMicros + 1,
      }),
    InvalidModelPricingError,
  );
});
