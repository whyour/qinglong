const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ModelGatewayProfileDrainingError,
  ModelGatewayProfileUnavailableError,
  ModelPriceCatalogManagementProfileUnavailableError,
  bootstrapModelPriceCatalogManagementProfile,
  bootstrapModelGatewayProfile,
} = require('@qinglong/ai/profile');

function repository(overrides = {}) {
  return {
    async findStart() {
      return null;
    },
    async findCompletion() {
      return null;
    },
    async findResolution() {
      return null;
    },
    async findUsage() {
      return null;
    },
    async findPriceQuote() {
      return null;
    },
    async findPriceSettlement() {
      return null;
    },
    async listProjectUsage() {
      return { records: [], hasMore: false };
    },
    async summarizeProjectUsage() {
      return {
        invocationCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        knownCostMicros: 0,
        unknownCostInvocations: 0,
      };
    },
    async findQuotaReservation() {
      return null;
    },
    async findQuotaSettlement() {
      return null;
    },
    async readQuotaWindowUsage() {
      return null;
    },
    async readAuthority() {
      return null;
    },
    async listIncomplete() {
      return {
        observedAtMs: 1,
        candidates: [],
        hasMore: false,
      };
    },
    async admit() {
      throw new Error('not used');
    },
    async complete() {
      throw new Error('not used');
    },
    async resolve() {
      throw new Error('not used');
    },
    ...overrides,
  };
}

function providerAuthority(dispose) {
  return {
    providers: [
      {
        type: 'remote',
        async listModels() {
          return [{ id: 'model-a' }];
        },
        async generate() {
          throw new Error('not used');
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    policies: {
      async resolve() {
        throw new Error('not used');
      },
    },
    dispose,
  };
}

function pricingAuthority(overrides = {}) {
  return {
    async resolve() {
      throw new Error('not used');
    },
    ...overrides,
  };
}

test('disabled AI Profile never reaches storage or provider credential loaders', async () => {
  let storageLoads = 0;
  let providerLoads = 0;
  const audits = [];
  const result = await bootstrapModelGatewayProfile({
    enabled: false,
    profile: 'edge',
    async loadStorage() {
      storageLoads += 1;
      throw new Error('must remain unreachable');
    },
    async loadProviders() {
      providerLoads += 1;
      throw new Error('must remain unreachable');
    },
    audit(record) {
      audits.push(record);
    },
  });

  assert.equal(result.status, 'disabled');
  assert.equal(await result.stop(), 'stopped');
  assert.equal(storageLoads, 0);
  assert.equal(providerLoads, 0);
  assert.deepEqual(audits, [{ profile: 'edge', state: 'disabled' }]);
});

test('enabled Edge AI Profile proves storage and recovery before providers', async () => {
  const order = [];
  const audits = [];
  const result = await bootstrapModelGatewayProfile({
    enabled: true,
    profile: 'edge',
    async loadStorage() {
      order.push('storage');
      return {
        repository: repository({
          async listIncomplete(limit) {
            order.push(`recovery:${limit}`);
            return {
              observedAtMs: 2,
              candidates: [],
              hasMore: false,
            };
          },
        }),
        pricing: pricingAuthority(),
        close() {
          order.push('storage.close');
        },
      };
    },
    async loadProviders() {
      order.push('providers');
      return providerAuthority(() => {
        order.push('providers.dispose');
      });
    },
    audit(record) {
      audits.push(record);
    },
  });

  assert.equal(result.status, 'active');
  assert.equal(result.capability.maxConcurrent, 1);
  assert.equal(result.capability.recoveryLimit, 4);
  assert.equal(result.capability.accepting, true);
  assert.deepEqual(order.slice(0, 3), ['storage', 'recovery:4', 'providers']);
  assert.deepEqual(
    audits.map(({ state }) => state),
    ['storage_ready', 'recovery_ready', 'active'],
  );
  assert.deepEqual(
    await result.capability.listProjectUsage({
      projectId: 'project-a',
      fromMsInclusive: 0,
      toMsExclusive: 1,
      limit: 1,
    }),
    { records: [], hasMore: false },
  );
  assert.equal(
    (
      await result.capability.summarizeProjectUsage({
        projectId: 'project-a',
        fromMsInclusive: 0,
        toMsExclusive: 1,
      })
    ).invocationCount,
    0,
  );
  assert.equal(
    await result.capability.readQuotaWindowUsage('project-a', 0),
    null,
  );
  assert.equal(await result.capability.findPriceQuote('request-a'), null);
  assert.equal(await result.capability.findPriceSettlement('request-a'), null);
  assert.equal(await result.capability.stop(), 'stopped');
  assert.equal(result.capability.accepting, false);
  assert.deepEqual(order, [
    'storage',
    'recovery:4',
    'providers',
    'providers.dispose',
    'storage.close',
  ]);
  assert.equal(await result.capability.stop(), 'stopped');
  assert.equal(order.filter((item) => item.endsWith('close')).length, 1);
  assert.equal(order.filter((item) => item.endsWith('dispose')).length, 1);
  assert.equal(audits.at(-1).state, 'stopped');
});

test('durable activation fence drains and releases authorities before a rejected operation', async () => {
  const order = [];
  const audits = [];
  let active = true;
  const result = await bootstrapModelGatewayProfile({
    enabled: true,
    profile: 'edge',
    async loadStorage() {
      return {
        repository: repository(),
        pricing: pricingAuthority(),
        close() {
          order.push('storage.close');
        },
      };
    },
    async loadProviders() {
      return providerAuthority(() => {
        order.push('providers.dispose');
      });
    },
    confirmActive() {
      if (!active) throw new Error('feature generation changed');
    },
    audit(record) {
      audits.push(record);
    },
  });

  assert.equal(result.status, 'active');
  active = false;
  await assert.rejects(
    result.capability.listProjectUsage({
      projectId: 'project-a',
      fromMsInclusive: 0,
      toMsExclusive: 1,
      limit: 1,
    }),
    ModelGatewayProfileDrainingError,
  );
  assert.equal(result.capability.accepting, false);
  assert.equal(result.capability.activeOperations, 0);
  assert.deepEqual(order, ['providers.dispose', 'storage.close']);
  assert.deepEqual(
    audits.map(({ state }) => state),
    ['storage_ready', 'recovery_ready', 'active', 'draining', 'stopped'],
  );
  assert.equal(await result.capability.stop(), 'stopped');
});

test('an explicit stop automatically releases authorities when the final operation drains', async () => {
  const order = [];
  let release;
  let started;
  const operationStarted = new Promise((resolve) => {
    started = resolve;
  });
  const operationRelease = new Promise((resolve) => {
    release = resolve;
  });
  const result = await bootstrapModelGatewayProfile({
    enabled: true,
    profile: 'standalone',
    async loadStorage() {
      return {
        repository: repository({
          async listProjectUsage() {
            started();
            await operationRelease;
            return { records: [], hasMore: false };
          },
        }),
        pricing: pricingAuthority(),
        close() {
          order.push('storage.close');
        },
      };
    },
    async loadProviders() {
      return providerAuthority(() => {
        order.push('providers.dispose');
      });
    },
    audit() {},
  });

  assert.equal(result.status, 'active');
  const operation = result.capability.listProjectUsage({
    projectId: 'project-a',
    fromMsInclusive: 0,
    toMsExclusive: 1,
    limit: 1,
  });
  await operationStarted;
  assert.equal(await result.capability.stop(), 'draining');
  assert.equal(result.capability.accepting, false);
  release();
  await operation;
  assert.equal(await result.capability.stop(), 'stopped');
  assert.deepEqual(order, ['providers.dispose', 'storage.close']);
});

test('AI Profile fails closed before provider credentials when recovery is truncated', async () => {
  const order = [];
  const audits = [];
  await assert.rejects(
    bootstrapModelGatewayProfile({
      enabled: true,
      profile: 'cluster',
      async loadStorage() {
        order.push('storage');
        return {
          repository: repository({
            async listIncomplete(limit) {
              order.push(`recovery:${limit}`);
              return {
                observedAtMs: 3,
                candidates: [],
                hasMore: true,
              };
            },
          }),
          pricing: pricingAuthority(),
          close() {
            order.push('storage.close');
          },
        };
      },
      async loadProviders() {
        order.push('providers');
        return providerAuthority();
      },
      audit(record) {
        audits.push(record);
      },
    }),
    ModelGatewayProfileUnavailableError,
  );
  assert.deepEqual(order, ['storage', 'recovery:128', 'storage.close']);
  assert.deepEqual(
    audits.map(({ state }) => state),
    ['storage_ready', 'failed'],
  );
});

test('AI Profile closes incomplete storage authority before provider credentials', async () => {
  const order = [];
  const audits = [];
  await assert.rejects(
    bootstrapModelGatewayProfile({
      enabled: true,
      profile: 'edge',
      async loadStorage() {
        order.push('storage');
        return {
          repository: repository(),
          close() {
            order.push('storage.close');
          },
        };
      },
      async loadProviders() {
        order.push('providers');
        return providerAuthority();
      },
      audit(record) {
        audits.push(record);
      },
    }),
    ModelGatewayProfileUnavailableError,
  );
  assert.deepEqual(order, ['storage', 'storage.close']);
  assert.deepEqual(
    audits.map(({ state }) => state),
    ['failed'],
  );
});

function modelPriceCatalogManagementAuthority(overrides = {}) {
  return {
    repository: {
      async findPublication() {
        return null;
      },
      async findCurrent() {
        return null;
      },
      async findAuthorization() {
        return null;
      },
      async publishAuthorized() {
        throw new Error('not used');
      },
      async transitionAuthorized() {
        throw new Error('not used');
      },
    },
    authorizer: {
      async authorize() {
        throw new Error('not used');
      },
    },
    ...overrides,
  };
}

test('disabled price catalog management is loader-free on constrained Edge', async () => {
  let authorityLoads = 0;
  const audits = [];
  const result = await bootstrapModelPriceCatalogManagementProfile({
    enabled: false,
    profile: 'edge',
    async loadAuthority() {
      authorityLoads += 1;
      throw new Error('must remain unreachable');
    },
    audit(record) {
      audits.push(record);
    },
  });

  assert.equal(result.status, 'disabled');
  assert.equal(result.decisionMode, 'human_confirmation');
  assert.equal(await result.stop(), 'stopped');
  assert.equal(authorityLoads, 0);
  assert.deepEqual(audits, [
    {
      profile: 'edge',
      state: 'disabled',
      decisionMode: 'human_confirmation',
    },
  ]);
});

test('standalone price catalog management lazily activates human confirmation authority', async () => {
  const order = [];
  const audits = [];
  const result = await bootstrapModelPriceCatalogManagementProfile({
    enabled: true,
    profile: 'standalone',
    async loadAuthority() {
      order.push('authority');
      return modelPriceCatalogManagementAuthority({
        close() {
          order.push('authority.close');
        },
      });
    },
    audit(record) {
      audits.push(record);
    },
  });

  assert.equal(result.status, 'active');
  assert.equal(result.decisionMode, 'human_confirmation');
  assert.equal(result.capability.accepting, true);
  assert.equal(result.capability.activeOperations, 0);
  assert.equal(await result.capability.stop(), 'stopped');
  assert.equal(result.capability.accepting, false);
  assert.equal(await result.capability.stop(), 'stopped');
  assert.deepEqual(order, ['authority', 'authority.close']);
  assert.deepEqual(
    audits.map(({ state }) => state),
    ['authority_ready', 'active', 'stopped'],
  );
});

test('cluster price catalog management fails closed without quota authority', async () => {
  const order = [];
  const audits = [];
  await assert.rejects(
    bootstrapModelPriceCatalogManagementProfile({
      enabled: true,
      profile: 'cluster',
      async loadAuthority() {
        order.push('authority');
        return modelPriceCatalogManagementAuthority({
          close() {
            order.push('authority.close');
          },
        });
      },
      audit(record) {
        audits.push(record);
      },
    }),
    ModelPriceCatalogManagementProfileUnavailableError,
  );

  assert.deepEqual(order, ['authority', 'authority.close']);
  assert.deepEqual(audits, [
    {
      profile: 'cluster',
      state: 'failed',
      decisionMode: 'separation_of_duty',
    },
  ]);
});

test('cluster price catalog management requires separation of duty and quota', async () => {
  const order = [];
  const audits = [];
  const result = await bootstrapModelPriceCatalogManagementProfile({
    enabled: true,
    profile: 'cluster',
    async loadAuthority() {
      order.push('authority');
      return modelPriceCatalogManagementAuthority({
        quota: {
          async consume() {
            throw new Error('not used');
          },
        },
        close() {
          order.push('authority.close');
        },
      });
    },
    audit(record) {
      audits.push(record);
    },
  });

  assert.equal(result.status, 'active');
  assert.equal(result.decisionMode, 'separation_of_duty');
  assert.equal(result.capability.decisionMode, 'separation_of_duty');
  assert.equal(await result.capability.stop(), 'stopped');
  assert.deepEqual(order, ['authority', 'authority.close']);
  assert.deepEqual(
    audits.map(({ state }) => state),
    ['authority_ready', 'active', 'stopped'],
  );
});
