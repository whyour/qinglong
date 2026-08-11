const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BoundedModelGateway,
  ModelAuditUnavailableError,
  ModelBudgetExceededError,
  ModelGatewayBusyError,
  ModelInvocationAbortedError,
  ModelInvocationDeadlineExceededError,
  ModelInvocationReplayBlockedError,
  ModelPolicyDeniedError,
} = require('../dist/model-gateway/gateway.js');
const {
  ModelPriceUnavailableError,
  StaticModelPriceCatalog,
  createModelPriceCatalogEntry,
} = require('../dist/pricing/pricing.js');
const {
  InvalidModelValueError,
  normalizeModelInvocationPolicy,
} = require('../dist/model-gateway/validation.js');

const NOW = 1_000_000;
const disabledPricing = Object.freeze({
  async resolve() {
    throw new Error('pricing must remain unreachable');
  },
});

function request(overrides = {}) {
  return {
    provider: 'remote',
    model: 'model-a',
    messages: [{ role: 'user', content: 'top secret prompt' }],
    maxOutputTokens: 16,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    projectId: 'project-a',
    runId: 'run-a',
    stepRunId: 'step-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    deadlineAtMs: NOW + 10_000,
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    revision: 'policy-1',
    allowedProviders: ['remote'],
    allowedModels: ['model-a'],
    maxInputBytes: 4096,
    maxOutputBytes: 4096,
    maxOutputTokens: 64,
    maxTotalTokens: 256,
    maxCostMicros: null,
    priceRevision: null,
    ...overrides,
  };
}

function provider(overrides = {}) {
  return {
    type: 'remote',
    async listModels() {
      return [{ id: 'model-a' }];
    },
    async generate() {
      return {
        provider: 'remote',
        model: 'model-a',
        text: 'safe summary',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      };
    },
    async *stream() {
      yield { delta: 'safe ' };
      yield {
        delta: 'summary',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      };
    },
    ...overrides,
  };
}

test('policy rejects an output token limit above its total token limit', () => {
  assert.throws(
    () =>
      normalizeModelInvocationPolicy(
        policy({ maxOutputTokens: 65, maxTotalTokens: 64 }),
      ),
    InvalidModelValueError,
  );
});

function gateway({
  modelProvider = provider(),
  resolvedPolicy = policy(),
  auditRecords = [],
  maxConcurrent = 1,
} = {}) {
  return new BoundedModelGateway({
    providers: [modelProvider],
    policies: {
      async resolve() {
        return resolvedPolicy;
      },
    },
    pricing: disabledPricing,
    audit: {
      async record(record) {
        auditRecords.push(record);
      },
    },
    maxConcurrent,
    now: () => NOW,
  });
}

test('generate binds Project/Run/StepRun and emits content-free bounded audit', async () => {
  const auditRecords = [];
  const instance = gateway({ auditRecords });

  const result = await instance.generate(request(), context());

  assert.equal(result.text, 'safe summary');
  assert.equal(instance.activeInvocations, 0);
  assert.deepEqual(
    auditRecords.map((record) => record.phase),
    ['admitted', 'completed'],
  );
  assert.equal(auditRecords[0].projectId, 'project-a');
  assert.equal(auditRecords[0].runId, 'run-a');
  assert.equal(auditRecords[0].stepRunId, 'step-a');
  assert.match(auditRecords[0].requestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    JSON.stringify(auditRecords).includes('top secret prompt'),
    false,
  );
  assert.equal(JSON.stringify(auditRecords).includes('safe summary'), false);
  assert.deepEqual(auditRecords[1].usage, {
    inputTokens: 5,
    outputTokens: 2,
    totalTokens: 7,
  });
});

test('priced invocation snapshots one exact revision before provider I/O', async () => {
  const records = [];
  let providerCalls = 0;
  const pricing = new StaticModelPriceCatalog([
    createModelPriceCatalogEntry({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
      currency: 'USD',
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
      publishedAtMs: NOW - 1,
    }),
  ]);
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async generate() {
          providerCalls += 1;
          return {
            provider: 'remote',
            model: 'model-a',
            text: 'safe summary',
            finishReason: 'stop',
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 7,
              costMicros: 99_999,
            },
          };
        },
      }),
    ],
    policies: {
      async resolve() {
        return policy({
          priceRevision: 'price-1',
          maxCostMicros: 100,
          projectQuota: {
            revision: 'quota-1',
            windowMs: 3_600_000,
            maxInvocations: 10,
            maxTokens: 10_000,
            maxCostMicros: 1_000,
          },
        });
      },
    },
    pricing,
    audit: {
      async record(record) {
        records.push({ record });
      },
      async recordWithPricing(record, quote, quotaAdmission) {
        records.push({ record, quote, quotaAdmission });
      },
    },
    maxConcurrent: 1,
    now: () => NOW,
  });

  const result = await instance.generate(request(), context());

  assert.equal(providerCalls, 1);
  assert.equal(records[0].record.phase, 'admitted');
  assert.equal(records[0].quote.priceRevision, 'price-1');
  assert.equal(records[0].quote.reservedCostMicros, 46);
  assert.equal(records[0].quotaAdmission.reservedCostMicros, 46);
  assert.equal(records[1].record.usage.costMicros, 3);
  assert.equal(result.usage.costMicros, 3);
});

test('missing exact price revision fails before provider I/O', async () => {
  let providerCalls = 0;
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async generate() {
          providerCalls += 1;
          throw new Error('must remain unreachable');
        },
      }),
    ],
    policies: {
      async resolve() {
        return policy({ priceRevision: 'missing-price' });
      },
    },
    pricing: {
      async resolve() {
        return null;
      },
    },
    audit: {
      async record() {
        throw new Error('must remain unreachable');
      },
    },
    maxConcurrent: 1,
    now: () => NOW,
  });

  await assert.rejects(
    instance.generate(request(), context()),
    ModelPriceUnavailableError,
  );
  assert.equal(providerCalls, 0);
});

test('policy denies a provider or model before external I/O', async () => {
  let calls = 0;
  const instance = gateway({
    resolvedPolicy: policy({ allowedModels: ['model-b'] }),
    modelProvider: provider({
      async generate() {
        calls += 1;
        throw new Error('must not run');
      },
    }),
  });

  await assert.rejects(
    instance.generate(request(), context()),
    ModelPolicyDeniedError,
  );
  assert.equal(calls, 0);
  assert.equal(instance.activeInvocations, 0);
});

test('durable admission replay never invokes the provider again', async () => {
  let calls = 0;
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async generate() {
          calls += 1;
          return provider().generate();
        },
      }),
    ],
    policies: {
      async resolve() {
        return policy();
      },
    },
    pricing: disabledPricing,
    audit: {
      async record(record) {
        return {
          status: record.phase === 'admitted' ? 'existing' : 'created',
        };
      },
    },
    maxConcurrent: 1,
    now: () => NOW,
  });

  await assert.rejects(
    instance.generate(request(), context()),
    ModelInvocationReplayBlockedError,
  );
  assert.equal(calls, 0);
  assert.equal(instance.activeInvocations, 0);
});

test('post-response token and byte budgets fail closed and are audited', async () => {
  const auditRecords = [];
  const instance = gateway({
    auditRecords,
    resolvedPolicy: policy({ maxOutputBytes: 4 }),
  });

  await assert.rejects(
    instance.generate(request(), context()),
    ModelBudgetExceededError,
  );
  assert.deepEqual(
    auditRecords.map((record) => [record.phase, record.errorCode]),
    [
      ['admitted', null],
      ['failed', 'MODEL_BUDGET_EXCEEDED'],
    ],
  );
});

test('process-local concurrency is bounded without a hidden queue', async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const instance = gateway({
    modelProvider: provider({
      async generate() {
        await blocked;
        return {
          provider: 'remote',
          model: 'model-a',
          text: 'ok',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    }),
  });

  const first = instance.generate(request(), context());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instance.activeInvocations, 1);
  await assert.rejects(
    instance.generate(
      request(),
      context({ requestId: 'request-b', traceId: 'trace-b' }),
    ),
    ModelGatewayBusyError,
  );
  release();
  await first;
  assert.equal(instance.activeInvocations, 0);
});

test('policy resolution consumes concurrency and cannot bypass the deadline', async (t) => {
  const now = 1_000_000;
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now,
  });
  let releasePolicy;
  const pendingPolicy = new Promise((resolve) => {
    releasePolicy = resolve;
  });
  let markPolicyEntered;
  const policyEntered = new Promise((resolve) => {
    markPolicyEntered = resolve;
  });
  let providerCalls = 0;
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async generate(...args) {
          providerCalls += 1;
          return provider().generate(...args);
        },
      }),
    ],
    policies: {
      async resolve() {
        markPolicyEntered();
        return pendingPolicy;
      },
    },
    pricing: disabledPricing,
    audit: { async record() {} },
    maxConcurrent: 1,
  });
  const first = instance.generate(
    request(),
    context({ deadlineAtMs: now + 40 }),
  );
  await policyEntered;
  assert.equal(instance.activeInvocations, 1);
  await assert.rejects(
    instance.generate(
      request(),
      context({
        requestId: 'request-policy-b',
        traceId: 'trace-policy-b',
        deadlineAtMs: Date.now() + 1000,
      }),
    ),
    ModelGatewayBusyError,
  );
  t.mock.timers.tick(40);
  await assert.rejects(first, ModelInvocationDeadlineExceededError);
  assert.equal(providerCalls, 0);
  assert.equal(instance.activeInvocations, 0);
  releasePolicy(policy());
});

test('a provider that ignores AbortSignal cannot hold the gateway past deadline', async () => {
  const auditRecords = [];
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async generate() {
          return new Promise(() => {});
        },
      }),
    ],
    policies: {
      async resolve() {
        return policy();
      },
    },
    pricing: disabledPricing,
    audit: {
      async record(record) {
        auditRecords.push(record);
      },
    },
    maxConcurrent: 1,
  });
  const startedAt = Date.now();

  await assert.rejects(
    instance.generate(request(), context({ deadlineAtMs: Date.now() + 40 })),
    ModelInvocationDeadlineExceededError,
  );

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(instance.activeInvocations, 0);
  assert.deepEqual(
    auditRecords.map((record) => [record.phase, record.errorCode]),
    [
      ['admitted', null],
      ['failed', 'MODEL_INVOCATION_DEADLINE_EXCEEDED'],
    ],
  );
});

test('durable admission is never detached when its deadline expires', async () => {
  let releaseAdmission;
  const admissionBarrier = new Promise((resolve) => {
    releaseAdmission = resolve;
  });
  let providerCalls = 0;
  const auditRecords = [];
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async generate(...args) {
          providerCalls += 1;
          return provider().generate(...args);
        },
      }),
    ],
    policies: {
      async resolve() {
        return policy();
      },
    },
    pricing: disabledPricing,
    audit: {
      async record(record) {
        auditRecords.push(record);
        if (record.phase === 'admitted') await admissionBarrier;
      },
    },
    maxConcurrent: 1,
  });
  const invocation = instance.generate(
    request(),
    context({ deadlineAtMs: Date.now() + 40 }),
  );

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(providerCalls, 0);
  assert.equal(instance.activeInvocations, 1);
  releaseAdmission();
  await assert.rejects(invocation, ModelInvocationDeadlineExceededError);
  assert.equal(providerCalls, 0);
  assert.equal(instance.activeInvocations, 0);
  assert.deepEqual(
    auditRecords.map((record) => [record.phase, record.errorCode]),
    [
      ['admitted', null],
      ['failed', 'MODEL_INVOCATION_DEADLINE_EXCEEDED'],
    ],
  );
});

test('stream requires final usage and audits consumer cancellation', async () => {
  const auditRecords = [];
  const instance = gateway({ auditRecords });
  const deltas = [];
  for await (const chunk of instance.stream(request(), context())) {
    deltas.push(chunk.delta);
  }
  assert.equal(deltas.join(''), 'safe summary');
  assert.deepEqual(
    auditRecords.map((record) => record.phase),
    ['admitted', 'completed'],
  );

  auditRecords.length = 0;
  for await (const chunk of instance.stream(
    request(),
    context({ requestId: 'request-cancel', traceId: 'trace-cancel' }),
  )) {
    assert.equal(chunk.delta, 'safe ');
    break;
  }
  assert.deepEqual(
    auditRecords.map((record) => [record.phase, record.errorCode]),
    [
      ['admitted', null],
      ['failed', 'MODEL_STREAM_CANCELLED'],
    ],
  );
  assert.equal(instance.activeInvocations, 0);
});

test('stream releases provider and concurrency when cancellation audit fails', async () => {
  let disposed = false;
  const instance = new BoundedModelGateway({
    providers: [
      provider({
        async *stream() {
          try {
            yield { delta: 'first' };
            yield {
              delta: 'last',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          } finally {
            disposed = true;
          }
        },
      }),
    ],
    policies: {
      async resolve() {
        return policy();
      },
    },
    pricing: disabledPricing,
    audit: {
      async record(record) {
        if (record.errorCode === 'MODEL_STREAM_CANCELLED') {
          throw new Error('audit unavailable');
        }
      },
    },
    maxConcurrent: 1,
    now: () => NOW,
  });

  await assert.rejects(async () => {
    for await (const _chunk of instance.stream(request(), context())) {
      break;
    }
  }, ModelAuditUnavailableError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, true);
  assert.equal(instance.activeInvocations, 0);
});
