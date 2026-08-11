const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createModelPriceCatalogHead,
  createModelPriceCatalogPublication,
  createModelPriceCatalogPublishCommand,
} = require('../dist/pricing/modelPriceCatalog.js');
const {
  InvalidModelPriceCatalogManagementValueError,
  ModelPriceCatalogManagementAuthenticationError,
  ModelPriceCatalogManagementAuthorizationError,
  ModelPriceCatalogManagementSeparationOfDutyError,
  createModelPriceCatalogAuthorization,
  createModelPriceCatalogManagementService,
  createModelPriceCatalogPolicyDecision,
  normalizeModelPriceCatalogAuthorization,
  normalizeModelPriceCatalogAuthorizationCommand,
} = require('../dist/pricing/modelPriceCatalogManagement.js');

const NOW = 2_000_000;

function principal(userId, assurance = 'multi_factor') {
  return {
    subject: { type: 'user', id: userId },
    authenticationId: `auth-${userId}`,
    authenticatedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    assurance,
  };
}

function policy(effect = 'allow') {
  return createModelPriceCatalogPolicyDecision({
    effect,
    revision: 'platform-policy-7',
    reasons: [effect === 'allow' ? 'catalog_operator' : 'catalog_denied'],
  });
}

function fakeRepository(publishedByUserId = 'publisher') {
  const calls = [];
  return {
    calls,
    async findPublication(lookup) {
      calls.push(['findPublication', lookup]);
      return createModelPriceCatalogPublication(
        createModelPriceCatalogPublishCommand({
          provider: lookup.provider,
          model: lookup.model,
          priceRevision: lookup.priceRevision,
          currency: 'USD',
          inputMicrosPerMillionTokens: 100,
          outputMicrosPerMillionTokens: 400,
          mutationId: 'existing-publication',
          publishedByUserId,
        }),
        NOW - 100,
      );
    },
    async findCurrent() {
      return null;
    },
    async findAuthorization() {
      return null;
    },
    async publish() {
      throw new Error('raw publish must not be used');
    },
    async transition() {
      throw new Error('raw transition must not be used');
    },
    async resolve() {
      return null;
    },
    async publishAuthorized(command, authorizationCommand) {
      calls.push(['publishAuthorized', command, authorizationCommand]);
      const publication = createModelPriceCatalogPublication(command, NOW);
      const authorization = createModelPriceCatalogAuthorization(
        authorizationCommand,
        publication.publicationDigest,
        NOW,
      );
      return { status: 'created', publication, authorization };
    },
    async transitionAuthorized(command, authorizationCommand) {
      calls.push(['transitionAuthorized', command, authorizationCommand]);
      const publication = await this.findPublication({
        provider: command.provider,
        model: command.model,
        priceRevision: command.priceRevision,
      });
      const head = createModelPriceCatalogHead(
        null,
        command,
        publication,
        false,
        NOW,
      );
      const authorization = createModelPriceCatalogAuthorization(
        authorizationCommand,
        head.headDigest,
        NOW,
      );
      return { status: 'created', head, authorization };
    },
  };
}

function publishRequest(userId = 'publisher') {
  return {
    authorizationId: 'authorize-publish-1',
    requestId: 'request-publish-1',
    mutationId: 'publish-price-1',
    provider: 'remote',
    model: 'model-a',
    principal: principal(userId),
    priceRevision: 'price-1',
    currency: 'USD',
    inputMicrosPerMillionTokens: 150_000,
    outputMicrosPerMillionTokens: 600_000,
  };
}

function transitionRequest(userId = 'reviewer') {
  return {
    authorizationId: 'authorize-activate-1',
    requestId: 'request-activate-1',
    mutationId: 'activate-price-1',
    provider: 'remote',
    model: 'model-a',
    principal: principal(userId),
    expectedGeneration: 0,
    expectedHeadDigest: null,
    action: 'activate',
    priceRevision: 'price-1',
  };
}

test('authorization fact binds strong User, policy, catalog command and commit', () => {
  const decision = policy();
  const serviceRepository = fakeRepository();
  const service = createModelPriceCatalogManagementService(serviceRepository, {
    decisionMode: 'human_confirmation',
    authorizer: {
      async authorize() {
        return decision;
      },
    },
    now: () => NOW,
  });

  return service.publish(publishRequest()).then((result) => {
    assert.equal(result.authorization.operation, 'publish');
    assert.equal(result.authorization.principal.subject.id, 'publisher');
    assert.equal(result.authorization.policy.revision, 'platform-policy-7');
    assert.equal(
      result.authorization.resultDigest,
      result.publication.publicationDigest,
    );
    assert.deepEqual(
      normalizeModelPriceCatalogAuthorization(result.authorization),
      result.authorization,
    );
    assert.deepEqual(
      normalizeModelPriceCatalogAuthorizationCommand(
        serviceRepository.calls[0][2],
      ),
      serviceRepository.calls[0][2],
    );
    assert.throws(
      () =>
        normalizeModelPriceCatalogAuthorization({
          ...result.authorization,
          resultDigest: 'f'.repeat(64),
        }),
      InvalidModelPriceCatalogManagementValueError,
    );
  });
});

test('management rejects weak principals and deny decisions before mutation', async () => {
  const repository = fakeRepository();
  let authorizations = 0;
  const service = createModelPriceCatalogManagementService(repository, {
    decisionMode: 'human_confirmation',
    authorizer: {
      async authorize() {
        authorizations += 1;
        return policy('deny');
      },
    },
    now: () => NOW,
  });

  await assert.rejects(
    service.publish({
      ...publishRequest(),
      principal: principal('publisher', 'single_factor'),
    }),
    ModelPriceCatalogManagementAuthenticationError,
  );
  assert.equal(authorizations, 0);
  await assert.rejects(
    service.publish(publishRequest()),
    ModelPriceCatalogManagementAuthorizationError,
  );
  assert.equal(authorizations, 1);
  assert.equal(
    repository.calls.some(([name]) => name === 'publishAuthorized'),
    false,
  );
});

test('cluster activation requires a different strong publishing User', async () => {
  const sameUserRepository = fakeRepository('publisher');
  const sameUserService = createModelPriceCatalogManagementService(
    sameUserRepository,
    {
      decisionMode: 'separation_of_duty',
      authorizer: {
        async authorize() {
          return policy();
        },
      },
      now: () => NOW,
    },
  );
  await assert.rejects(
    sameUserService.transition(transitionRequest('publisher')),
    ModelPriceCatalogManagementSeparationOfDutyError,
  );
  assert.equal(
    sameUserRepository.calls.some(([name]) => name === 'transitionAuthorized'),
    false,
  );

  const reviewedRepository = fakeRepository('publisher');
  const reviewedService = createModelPriceCatalogManagementService(
    reviewedRepository,
    {
      decisionMode: 'separation_of_duty',
      authorizer: {
        async authorize() {
          return policy();
        },
      },
      now: () => NOW,
    },
  );
  const result = await reviewedService.transition(
    transitionRequest('reviewer'),
  );
  assert.equal(result.head.activePriceRevision, 'price-1');
  assert.equal(result.authorization.principal.subject.id, 'reviewer');
  assert.equal(result.authorization.decisionMode, 'separation_of_duty');
});
