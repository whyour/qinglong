const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeAuthenticatedWorkerCredentialIdentity,
  normalizeCommitWorkerCredentialDeliveryCommand,
  normalizeMarkWorkerCredentialStageDiscardedCommand,
  normalizePublishWorkerCredentialDeliveryCommand,
  normalizeRevokePreviousWorkerCredentialDeliveryCommand,
  normalizeWorkerCredentialDeliveryRecoveryPage,
  normalizeWorkerCredentialDeliveryIntent,
  normalizeWorkerCredentialDeliveryRecord,
  normalizeWorkerCredentialStageDiscardRecord,
  normalizeWorkerCredentialStageDiscardRecoveryPage,
  workerCredentialDeliveryTokenDigest,
} = require('@qinglong/runtime-core/worker-credential-delivery');

const MUTATION_ID = '123e4567-e89b-42d3-a456-426614174601';

test('derives one bounded domain-separated delivery token digest', () => {
  assert.equal(
    workerCredentialDeliveryTokenDigest(Buffer.from('ql3w_example_secret')),
    'f768816a9182de755f235f0884ac9082bcab9420fcf46e89e3d2f02b5ad21446',
  );
  assert.throws(() => workerCredentialDeliveryTokenDigest(Buffer.alloc(0)));
  assert.throws(() => workerCredentialDeliveryTokenDigest(Buffer.alloc(257)));
});

function credentialCommand(overrides = {}) {
  return {
    expectedCurrentVersion: 0,
    credential: {
      credentialId: 'worker_generation_2',
      version: 1,
      state: 'active',
      workerId: 'edge-router-1',
      secretDigest: 'a'.repeat(64),
      createdAtMs: 1_000,
      notBeforeAtMs: 1_000,
      expiresAtMs: 2_000,
    },
    mutation: {
      mutationId: MUTATION_ID,
      operation: 'issue',
      credentialId: 'worker_generation_2',
      credentialVersion: 1,
      expectedPreviousVersion: 0,
      changedBy: { type: 'user', id: 'usr_admin' },
      createdAtMs: 1_000,
    },
    audit: {
      eventId: MUTATION_ID,
      requestId: 'request-worker-delivery-1',
      operationId: 'worker_credential.issue',
      projectId: null,
      subject: { type: 'user', id: 'usr_admin' },
      authenticationId: 'session:admin:1',
      outcome: 'allowed',
      reasons: ['worker_credential_admin'],
      fence: null,
      occurredAtMs: 1_000,
    },
    ...overrides,
  };
}

function committed(overrides = {}) {
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
    stagedAtMs: 1_000,
    credentialCommittedAtMs: 1_000,
    publishedAtMs: null,
    publicationDigest: null,
    observedAtMs: null,
    observedSessionId: null,
    observedSessionVersion: null,
    previousRevokedAtMs: null,
    ...overrides,
  };
}

test('normalizes an exact low-sensitive committed delivery fact', () => {
  const intent = normalizeWorkerCredentialDeliveryIntent({
    deliveryId: MUTATION_ID,
    workerId: 'edge-router-1',
    credentialId: 'worker_generation_2',
    credentialVersion: 1,
    previousCredentialId: 'worker_generation_1',
    secretDigest: 'a'.repeat(64),
    tokenDigest: 'b'.repeat(64),
    deploymentTargetDigest: 'c'.repeat(64),
    deploymentGeneration: 'secret-generation-2',
    stagedAtMs: 1_000,
  });
  assert.equal(Object.hasOwn(intent, 'state'), false);
  assert.equal(Object.hasOwn(intent, 'credentialCommittedAtMs'), false);
  const value = normalizeWorkerCredentialDeliveryRecord(committed());
  assert.deepEqual(value, committed());
  assert.equal(Object.isFrozen(value), true);
  const command = normalizeCommitWorkerCredentialDeliveryCommand({
    credential: credentialCommand(),
    delivery: value,
  });
  assert.equal(command.delivery.secretDigest, command.credential.credential.secretDigest);
  assert.equal(JSON.stringify(command).includes('ql3w_'), false);
});

test('binds orphan discard authorization to one exact staged intent', () => {
  const authorized = normalizeWorkerCredentialStageDiscardRecord({
    deliveryId: MUTATION_ID,
    version: 1,
    state: 'discard_authorized',
    workerId: 'edge-router-1',
    credentialId: 'worker_generation_2',
    credentialVersion: 1,
    previousCredentialId: 'worker_generation_1',
    secretDigest: 'a'.repeat(64),
    tokenDigest: 'b'.repeat(64),
    deploymentTargetDigest: 'c'.repeat(64),
    deploymentGeneration: 'secret-generation-2',
    stagedAtMs: 1_000,
    authorizedAtMs: 1_100,
    discardedAtMs: null,
  });
  assert.equal(authorized.state, 'discard_authorized');
  assert.deepEqual(
    normalizeMarkWorkerCredentialStageDiscardedCommand({
      deliveryId: MUTATION_ID,
      expectedVersion: 1,
    }),
    { deliveryId: MUTATION_ID, expectedVersion: 1 },
  );
  const page = normalizeWorkerCredentialStageDiscardRecoveryPage({
    observedAtMs: 1_200,
    discards: [authorized],
    truncated: true,
    nextCursor: MUTATION_ID,
  });
  assert.equal(page.discards[0].tokenDigest, 'b'.repeat(64));
  const discarded = normalizeWorkerCredentialStageDiscardRecord({
    ...authorized,
    version: 2,
    state: 'discarded',
    discardedAtMs: 1_200,
  });
  assert.throws(() => normalizeWorkerCredentialStageDiscardRecoveryPage({
    observedAtMs: 1_300,
    discards: [discarded],
    truncated: false,
  }));
  assert.throws(() => normalizeWorkerCredentialStageDiscardRecord({
    ...authorized,
    tokenDigest: 'd'.repeat(64),
    discardedAtMs: 1_200,
  }));
});

test('requires monotonic publication, observation and revoke evidence', () => {
  const published = normalizeWorkerCredentialDeliveryRecord(committed({
    version: 2,
    state: 'published',
    publishedAtMs: 1_100,
    publicationDigest: 'd'.repeat(64),
  }));
  const observed = normalizeWorkerCredentialDeliveryRecord({
    ...published,
    version: 3,
    state: 'observed',
    observedAtMs: 1_200,
    observedSessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
    observedSessionVersion: 4,
  });
  const revoked = normalizeWorkerCredentialDeliveryRecord({
    ...observed,
    version: 4,
    state: 'previous_revoked',
    previousRevokedAtMs: 1_300,
  });
  assert.equal(revoked.previousCredentialId, 'worker_generation_1');
  assert.deepEqual(
    normalizePublishWorkerCredentialDeliveryCommand({
      deliveryId: MUTATION_ID,
      expectedVersion: 1,
      publicationDigest: 'd'.repeat(64),
      publishedAtMs: 1_100,
    }),
    {
      deliveryId: MUTATION_ID,
      expectedVersion: 1,
      publicationDigest: 'd'.repeat(64),
      publishedAtMs: 1_100,
    },
  );
});

test('rejects same-ID rotation, widened records and incomplete state evidence', () => {
  for (const value of [
    committed({ previousCredentialId: 'worker_generation_2' }),
    committed({ token: 'ql3w_secret' }),
    committed({ version: 2, state: 'published' }),
    committed({ stagedAtMs: 1_001 }),
    committed({ credentialVersion: 2 }),
    committed({ deploymentTargetDigest: 'A'.repeat(64) }),
  ]) {
    assert.throws(() => normalizeWorkerCredentialDeliveryRecord(value));
  }
  assert.throws(() => normalizeCommitWorkerCredentialDeliveryCommand({
    credential: credentialCommand({
      mutation: {
        ...credentialCommand().mutation,
        operation: 'rotate',
      },
    }),
    delivery: committed(),
  }));
});

test('normalizes only server-authenticated Worker credential identity', () => {
  const identity = {
    workerId: 'edge-router-1',
    credentialId: 'worker_generation_2',
    credentialVersion: 1,
  };
  assert.deepEqual(
    normalizeAuthenticatedWorkerCredentialIdentity(identity),
    identity,
  );
  for (const value of [
    { ...identity, credentialVersion: 0 },
    { ...identity, workerId: '../edge-router-1' },
    { ...identity, deliveryId: MUTATION_ID },
  ]) {
    assert.throws(() => normalizeAuthenticatedWorkerCredentialIdentity(value));
  }
});

test('binds previous revoke and bounded recovery pages to delivery evidence', () => {
  const observed = normalizeWorkerCredentialDeliveryRecord({
    ...committed(),
    version: 3,
    state: 'observed',
    publishedAtMs: 1_100,
    publicationDigest: 'd'.repeat(64),
    observedAtMs: 1_200,
    observedSessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
    observedSessionVersion: 4,
  });
  const revoke = credentialCommand({
    expectedCurrentVersion: 1,
    credential: {
      credentialId: 'worker_generation_1',
      version: 2,
      state: 'revoked',
      workerId: 'edge-router-1',
      secretDigest: '0'.repeat(64),
      createdAtMs: 1_300,
      notBeforeAtMs: 1_300,
      expiresAtMs: 2_300,
    },
    mutation: {
      ...credentialCommand().mutation,
      mutationId: '123e4567-e89b-42d3-a456-426614174602',
      operation: 'revoke',
      credentialId: 'worker_generation_1',
      credentialVersion: 2,
      expectedPreviousVersion: 1,
      createdAtMs: 1_300,
    },
    audit: {
      ...credentialCommand().audit,
      eventId: '123e4567-e89b-42d3-a456-426614174602',
      operationId: 'worker_credential.revoke',
      occurredAtMs: 1_300,
    },
  });
  const terminal = normalizeWorkerCredentialDeliveryRecord({
    ...observed,
    version: 4,
    state: 'previous_revoked',
    previousRevokedAtMs: 1_300,
  });
  assert.equal(
    normalizeRevokePreviousWorkerCredentialDeliveryCommand({
      credential: revoke,
      delivery: terminal,
    }).delivery.state,
    'previous_revoked',
  );
  const page = normalizeWorkerCredentialDeliveryRecoveryPage({
    observedAtMs: 1_400,
    deliveries: [observed],
    truncated: true,
    nextCursor: observed.deliveryId,
  });
  assert.equal(page.nextCursor, MUTATION_ID);
  assert.throws(() => normalizeWorkerCredentialDeliveryRecoveryPage({
    observedAtMs: 1_400,
    deliveries: [terminal],
    truncated: false,
  }));
  assert.throws(() => normalizeRevokePreviousWorkerCredentialDeliveryCommand({
    credential: { ...revoke, expectedCurrentVersion: 2 },
    delivery: terminal,
  }));
});
