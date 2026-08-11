const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
} = require('@qinglong/runtime-core/worker-credential-delivery');
const {
  createRecoverableWorkerCredentialIssuer,
  createWorkerCredentialDeliveryRecoveryService,
  createWorkerCredentialStageCleanupService,
} = require('../dist/worker-credential/workerCredentialDelivery');

const NOW = 1_000;
const PEPPER = Buffer.alloc(32, 1).toString('base64url');
const MUTATION_ID = '123e4567-e89b-42d3-a456-426614174701';
const PRINCIPAL = {
  subject: { type: 'user', id: 'usr_admin' },
  authenticationId: 'session:admin:1',
  authenticatedAtMs: 900,
  expiresAtMs: 2_000,
  assurance: 'multi_factor',
};

function request(overrides = {}) {
  return {
    mutationId: MUTATION_ID,
    requestId: 'request-worker-delivery-1',
    expectedCurrentVersion: 0,
    credentialId: 'worker_generation_2',
    workerId: 'edge-router-1',
    principal: PRINCIPAL,
    notBeforeAtMs: NOW,
    expiresAtMs: 2_000,
    previousCredentialId: 'worker_generation_1',
    deploymentTargetDigest: 'c'.repeat(64),
    deploymentGeneration: 'secret-generation-2',
    ...overrides,
  };
}

function committedRecord(overrides = {}) {
  return {
    deliveryId: MUTATION_ID,
    version: 1,
    state: 'credential_committed',
    workerId: 'edge-router-1',
    credentialId: 'worker_generation_2',
    credentialVersion: 1,
    previousCredentialId: 'worker_generation_1',
    secretDigest: 'a'.repeat(64),
    tokenDigest: 'b'.repeat(64),
    deploymentTargetDigest: 'c'.repeat(64),
    deploymentGeneration: 'secret-generation-2',
    stagedAtMs: NOW,
    credentialCommittedAtMs: NOW,
    publishedAtMs: null,
    publicationDigest: null,
    observedAtMs: null,
    observedSessionId: null,
    observedSessionVersion: null,
    previousRevokedAtMs: null,
    ...overrides,
  };
}

function stagedIntent(overrides = {}) {
  const {
    version: _version,
    state: _state,
    credentialCommittedAtMs: _credentialCommittedAtMs,
    publishedAtMs: _publishedAtMs,
    publicationDigest: _publicationDigest,
    observedAtMs: _observedAtMs,
    observedSessionId: _observedSessionId,
    observedSessionVersion: _observedSessionVersion,
    previousRevokedAtMs: _previousRevokedAtMs,
    ...intent
  } = committedRecord();
  return { ...intent, ...overrides };
}

function fakeAuthority() {
  let resolved = null;
  let rawMutation = null;
  let stageDiscard = null;
  const revokeMutations = new Map();
  const state = {
    commits: 0,
    marks: 0,
    failMarkAfterCommit: false,
    revokes: 0,
  };
  const port = {
    async resolveMutation(mutationId) {
      if (resolved?.mutation.mutationId === mutationId) return resolved;
      return revokeMutations.get(mutationId) ?? rawMutation;
    },
    async append() {
      throw new Error('raw append must remain unreachable');
    },
    async resolveDelivery() {
      return resolved?.delivery ?? null;
    },
    async resolveDelivered() {
      return resolved;
    },
    async commitDelivered(command) {
      state.commits += 1;
      if (resolved) {
        return {
          status: 'existing',
          credential: resolved.credential,
          mutation: resolved.mutation,
        };
      }
      resolved = {
        credential: command.credential.credential,
        mutation: command.credential.mutation,
        audit: command.credential.audit,
        delivery: command.delivery,
      };
      return {
        status: 'created',
        credential: resolved.credential,
        mutation: resolved.mutation,
      };
    },
    async markPublished(command) {
      state.marks += 1;
      assert.ok(resolved);
      assert.equal(command.expectedVersion, resolved.delivery.version);
      resolved = {
        ...resolved,
        delivery: {
          ...resolved.delivery,
          version: 2,
          state: 'published',
          publishedAtMs: command.publishedAtMs,
          publicationDigest: command.publicationDigest,
        },
      };
      if (state.failMarkAfterCommit) {
        state.failMarkAfterCommit = false;
        throw new Error('commit response lost');
      }
      return resolved.delivery;
    },
    async listRecoveryPage(options = {}) {
      const delivery = resolved?.delivery;
      const recoverable = delivery &&
        delivery.state !== 'previous_revoked' &&
        !(delivery.state === 'observed' && delivery.previousCredentialId === null) &&
        (!options.afterDeliveryId || delivery.deliveryId > options.afterDeliveryId)
        ? [delivery]
        : [];
      return {
        observedAtMs: 1_500,
        deliveries: recoverable,
        truncated: false,
      };
    },
    async revokePreviousDelivered(command) {
      state.revokes += 1;
      const replay = revokeMutations.get(command.credential.mutation.mutationId);
      if (replay) {
        return {
          status: 'existing',
          credential: replay.credential,
          mutation: replay.mutation,
        };
      }
      const value = {
        credential: command.credential.credential,
        mutation: command.credential.mutation,
        audit: command.credential.audit,
      };
      revokeMutations.set(command.credential.mutation.mutationId, value);
      resolved = { ...resolved, delivery: command.delivery };
      return {
        status: 'created',
        credential: value.credential,
        mutation: value.mutation,
      };
    },
    async authorizeStageDiscard(intent) {
      if (resolved || rawMutation) throw new WorkerCredentialDeliveryConflictError();
      if (stageDiscard) {
        const { version, state, authorizedAtMs, discardedAtMs, ...existing } = stageDiscard;
        if (JSON.stringify(existing) !== JSON.stringify(intent)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        return stageDiscard;
      }
      stageDiscard = {
        ...intent,
        version: 1,
        state: 'discard_authorized',
        authorizedAtMs: 1_100,
        discardedAtMs: null,
      };
      return stageDiscard;
    },
    async markStageDiscarded(command) {
      if (!stageDiscard || command.expectedVersion !== 1) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      if (stageDiscard.state === 'discarded') return stageDiscard;
      stageDiscard = {
        ...stageDiscard,
        version: 2,
        state: 'discarded',
        discardedAtMs: 1_200,
      };
      return stageDiscard;
    },
    async listStageDiscardRecoveryPage() {
      return {
        observedAtMs: 1_300,
        discards: stageDiscard?.state === 'discard_authorized'
          ? [stageDiscard]
          : [],
        truncated: false,
      };
    },
  };
  return {
    port,
    state,
    current: () => resolved,
    setRaw(value) { rawMutation = value; },
    setDelivery(delivery) { resolved = { ...resolved, delivery }; },
    stageDiscard: () => stageDiscard,
  };
}

function fakeAdapter() {
  let staged = null;
  let token = null;
  const state = {
    stages: 0,
    publishes: 0,
    discards: 0,
    failPublish: false,
    passedToken: null,
  };
  const port = {
    async inspect() { return staged; },
    async stage(delivery, value) {
      state.stages += 1;
      if (staged) throw new Error('no replace');
      staged = delivery;
      state.passedToken = value;
      token = Buffer.from(value);
    },
    async publish(delivery) {
      state.publishes += 1;
      if (state.failPublish) throw new Error('deployment unavailable');
      assert.ok(staged);
      assert.equal(delivery.deliveryId, staged.deliveryId);
      assert.ok(token.toString('utf8').startsWith('ql3w_worker_generation_2_'));
      return { publicationDigest: 'd'.repeat(64) };
    },
    async discard(delivery) {
      state.discards += 1;
      assert.equal(delivery.deliveryId, staged?.deliveryId);
      token?.fill(0);
      token = null;
      staged = null;
    },
    async listStaged() {
      return {
        stages: staged ? [staged] : [],
        truncated: false,
      };
    },
  };
  return {
    port,
    state,
    seed(delivery) { staged = delivery; token = Buffer.from('seed'); },
    clear() { staged = null; token?.fill(0); token = null; },
  };
}

function issuer(authority, adapter, options = {}) {
  return createRecoverableWorkerCredentialIssuer(
    authority.port,
    adapter.port,
    PEPPER,
    { now: () => NOW, ...options },
  );
}

function recovery(authority, adapter) {
  return createWorkerCredentialDeliveryRecoveryService(
    authority.port,
    adapter.port,
    PEPPER,
    PRINCIPAL,
  );
}

test('stages before one atomic credential commit and publishes without returning a token', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  const generated = Buffer.alloc(32, 7);
  const result = await issuer(authority, adapter, {
    randomBytes: () => generated,
  }).issue(request());
  assert.equal(result.status, 'published');
  assert.equal(result.delivery.state, 'published');
  assert.equal(authority.state.commits, 1);
  assert.equal(authority.state.marks, 1);
  assert.equal(adapter.state.stages, 1);
  assert.equal(adapter.state.publishes, 1);
  assert.equal(generated.every((byte) => byte === 0), true);
  assert.equal(adapter.state.passedToken.every((byte) => byte === 0), true);
  assert.equal(JSON.stringify(authority.current()).includes('ql3w_'), false);
});

test('publishes a preapproved credential after execution delay', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  const result = await issuer(authority, adapter, {
    now: () => 1_500,
    randomBytes: () => Buffer.alloc(32, 7),
  }).issue(request());
  assert.equal(result.status, 'published');
  assert.equal(authority.current().credential.createdAtMs, 1_500);
  assert.equal(authority.current().credential.notBeforeAtMs, NOW);
});

test('resumes a committed credential after publication failure without new entropy', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  let randomCalls = 0;
  const service = issuer(authority, adapter, {
    randomBytes() { randomCalls += 1; return Buffer.alloc(32, randomCalls); },
  });
  adapter.state.failPublish = true;
  await assert.rejects(service.issue(request()), WorkerCredentialDeliveryUnavailableError);
  assert.equal(authority.current().delivery.state, 'credential_committed');
  adapter.state.failPublish = false;
  const recovered = await service.issue(request());
  assert.equal(recovered.status, 'existing');
  assert.equal(recovered.delivery.state, 'published');
  assert.equal(randomCalls, 1);
  assert.equal(authority.state.commits, 1);
  assert.equal(adapter.state.stages, 1);
  assert.equal(adapter.state.publishes, 2);
});

test('recovers a lost publication-ledger response without republishing', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  let randomCalls = 0;
  const service = issuer(authority, adapter, {
    randomBytes() { randomCalls += 1; return Buffer.alloc(32, 9); },
  });
  authority.state.failMarkAfterCommit = true;
  await assert.rejects(service.issue(request()), WorkerCredentialDeliveryUnavailableError);
  assert.equal(authority.current().delivery.state, 'published');
  const recovered = await service.issue(request());
  assert.equal(recovered.status, 'existing');
  assert.equal(recovered.delivery.state, 'published');
  assert.equal(randomCalls, 1);
  assert.equal(adapter.state.publishes, 1);
  assert.equal(authority.state.commits, 1);
});

test('discards an orphaned pre-commit stage only after authoritative absence', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  adapter.seed(stagedIntent());
  let randomCalls = 0;
  const result = await issuer(authority, adapter, {
    randomBytes() { randomCalls += 1; return Buffer.alloc(32, 1); },
  }).issue(request());
  assert.deepEqual(result, {
    status: 'orphaned_stage_discarded',
    delivery: null,
  });
  assert.equal(adapter.state.discards, 1);
  assert.equal(authority.state.commits, 0);
  assert.equal(randomCalls, 0);
});

test('fails closed for raw mutations, missing staged secrets and semantic drift', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  authority.setRaw({ credential: {}, mutation: {}, audit: {} });
  await assert.rejects(
    issuer(authority, adapter).issue(request()),
    WorkerCredentialDeliveryConflictError,
  );

  const committedAuthority = fakeAuthority();
  const committedAdapter = fakeAdapter();
  await issuer(committedAuthority, committedAdapter, {
    randomBytes: () => Buffer.alloc(32, 4),
  }).issue(request());
  committedAdapter.clear();
  await assert.rejects(
    issuer(committedAuthority, committedAdapter).issue(request()),
    WorkerCredentialDeliveryConflictError,
  );
  await assert.rejects(
    issuer(committedAuthority, fakeAdapter()).issue(request({
      deploymentGeneration: 'other-generation',
    })),
    WorkerCredentialDeliveryConflictError,
  );
});

test('preserves deployment semantic conflicts for manual review', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  adapter.port.publish = async () => {
    throw new WorkerCredentialDeliveryConflictError();
  };
  await assert.rejects(
    issuer(authority, adapter, {
      randomBytes: () => Buffer.alloc(32, 6),
    }).issue(request()),
    WorkerCredentialDeliveryConflictError,
  );
  assert.equal(authority.current().delivery.state, 'credential_committed');
});

test('authorizes cleanup before discarding one globally inventoried stage', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  adapter.seed(stagedIntent());
  const service = createWorkerCredentialStageCleanupService(
    authority.port,
    adapter.port,
  );
  const result = await service.cleanupInventoryPage({ limit: 1 });
  assert.deepEqual(result, {
    outcomes: [{ deliveryId: MUTATION_ID, result: 'discarded' }],
    truncated: false,
  });
  assert.equal(authority.stageDiscard().state, 'discarded');
  assert.equal(adapter.state.discards, 1);
  assert.equal(await adapter.port.inspect(MUTATION_ID), null);
});

test('recovers an authorized discard after the stage removal response is lost', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  const intent = stagedIntent();
  adapter.seed(intent);
  await authority.port.authorizeStageDiscard(intent);
  adapter.clear();
  const service = createWorkerCredentialStageCleanupService(
    authority.port,
    adapter.port,
  );
  const result = await service.recoverAuthorizedPage({ limit: 1 });
  assert.equal(result.observedAtMs, 1_300);
  assert.deepEqual(result.outcomes, [
    { deliveryId: MUTATION_ID, result: 'discarded' },
  ]);
  assert.equal(authority.stageDiscard().version, 2);
  assert.equal(adapter.state.discards, 0);
});

test('fails closed when an authorized stage is semantically rewritten', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  const intent = stagedIntent();
  await authority.port.authorizeStageDiscard(intent);
  adapter.seed(stagedIntent({ tokenDigest: 'e'.repeat(64) }));
  await assert.rejects(
    createWorkerCredentialStageCleanupService(
      authority.port,
      adapter.port,
    ).recoverAuthorizedPage(),
    WorkerCredentialDeliveryConflictError,
  );
  assert.equal(authority.stageDiscard().state, 'discard_authorized');
  assert.equal(adapter.state.discards, 0);
});

test('rejects same-ID rotation and widened requests before touching authority', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  const service = issuer(authority, adapter);
  await assert.rejects(
    service.issue(request({ previousCredentialId: 'worker_generation_2' })),
    /requires a new credential ID|identity is invalid/,
  );
  await assert.rejects(
    service.issue(request({ debug: true })),
    /shape is invalid/,
  );
  assert.equal(authority.state.commits, 0);
  assert.equal(adapter.state.stages, 0);
});

test('recovers publication then atomically revokes the observed previous credential', async () => {
  const authority = fakeAuthority();
  const adapter = fakeAdapter();
  adapter.state.failPublish = true;
  await assert.rejects(
    issuer(authority, adapter, {
      randomBytes: () => Buffer.alloc(32, 8),
    }).issue(request()),
    WorkerCredentialDeliveryUnavailableError,
  );
  adapter.state.failPublish = false;
  const publication = await recovery(authority, adapter).recoverPage();
  assert.deepEqual(publication.outcomes, [{
    deliveryId: MUTATION_ID,
    state: 'published',
    result: 'published',
  }]);

  authority.setDelivery({
    ...authority.current().delivery,
    version: 3,
    state: 'observed',
    observedAtMs: 1_500,
    observedSessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
    observedSessionVersion: 4,
  });
  const revoked = await recovery(authority, adapter).recoverPage();
  assert.deepEqual(revoked.outcomes, [{
    deliveryId: MUTATION_ID,
    state: 'previous_revoked',
    result: 'previous_revoked',
  }]);
  assert.equal(authority.state.revokes, 1);
  assert.equal(authority.current().delivery.previousRevokedAtMs, 1_500);
  const replay = await recovery(authority, adapter).recoverPage();
  assert.deepEqual(replay.outcomes, []);
  assert.equal(authority.state.revokes, 1);
});
