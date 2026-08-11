const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialDeliveryConflictError,
} = require('@qinglong/runtime-core/worker-credential-delivery');
const {
  PostgresWorkerCredentialAdministrationRepository,
} = require('../dist/entrypoints/admin');

const MUTATION_ID = '123e4567-e89b-42d3-a456-426614174801';

function credentialCommand() {
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
  };
}

function delivery(overrides = {}) {
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

function stageIntent(overrides = {}) {
  const { version, state, credentialCommittedAtMs, publishedAtMs,
    publicationDigest, observedAtMs, observedSessionId,
    observedSessionVersion, previousRevokedAtMs, ...intent } = delivery();
  return { ...intent, ...overrides };
}

function fakePool() {
  const state = {
    audit: null,
    credential: null,
    mutation: null,
    deliveries: [],
    discards: [],
    calls: [],
    releases: 0,
    loseFirstCommitResponse: false,
  };

  function mutationRow() {
    if (!state.mutation) return [];
    return [{
      mutationId: state.mutation.mutationId,
      operation: state.mutation.operation,
      credentialId: state.mutation.credentialId,
      credentialVersion: state.mutation.credentialVersion,
      expectedPreviousVersion: state.mutation.expectedPreviousVersion,
      changedByType: state.mutation.changedByType,
      changedById: state.mutation.changedById,
      createdAtMs: state.mutation.createdAtMs,
      state: state.credential.state,
      workerId: state.credential.workerId,
      secretDigest: state.credential.secretDigest,
      notBeforeAtMs: state.credential.notBeforeAtMs,
      expiresAtMs: state.credential.expiresAtMs,
      auditEventId: state.audit.eventId,
      auditRequestId: state.audit.requestId,
      auditOperationId: state.audit.operationId,
      auditProjectId: state.audit.projectId,
      auditSubjectType: state.audit.subjectType,
      auditSubjectId: state.audit.subjectId,
      auditAuthenticationId: state.audit.authenticationId,
      auditOutcome: state.audit.outcome,
      auditReasons: state.audit.reasons,
      auditProjectVersion: state.audit.projectVersion,
      auditBindingVersion: state.audit.bindingVersion,
      auditOccurredAtMs: state.audit.occurredAtMs,
    }];
  }

  function deliveryRows() {
    return state.deliveries.map((value) => ({ ...value }));
  }

  async function query(text, params = []) {
    state.calls.push(text);
    if (text === 'COMMIT') {
      if (state.loseFirstCommitResponse) {
        state.loseFirstCommitResponse = false;
        const error = new Error('commit response lost');
        error.code = '40001';
        throw error;
      }
      return { rows: [] };
    }
    if (
      text === 'ROLLBACK' ||
      text.startsWith('BEGIN') ||
      text.includes('set_config') ||
      text.includes('pg_advisory_xact_lock')
    ) return { rows: [] };
    if (text.includes('FROM "ql3"."worker_credential_mutations" AS mutation')) {
      return { rows: mutationRow() };
    }
    if (text.startsWith('WITH observation AS (') &&
        text.includes('worker_credential_stage_discards')) {
      const latest = new Map();
      for (const record of state.discards) latest.set(record.deliveryId, record);
      const rows = [...latest.values()]
        .filter((record) => record.state === 'discard_authorized')
        .sort((a, b) => a.deliveryId.localeCompare(b.deliveryId))
        .slice(0, params[1])
        .map((record) => ({ ...record, observedAtMs: 1_300 }));
      return { rows: rows.length > 0 ? rows : [{ deliveryId: null, observedAtMs: 1_300 }] };
    }
    if (text.includes('FROM "ql3"."worker_credential_stage_discards"')) {
      return { rows: state.discards.map((value) => ({ ...value })) };
    }
    if (text.includes('AS "authorizedAtMs"') && text.includes('mutationExists')) {
      return { rows: [{
        authorizedAtMs: 1_100,
        mutationExists: state.mutation !== null,
        deliveryExists: state.deliveries.length > 0,
      }] };
    }
    if (text.includes('AS "discardedAtMs"')) {
      return { rows: [{ discardedAtMs: 1_200 }] };
    }
    if (text.includes('FROM "ql3"."worker_credential_deliveries"')) {
      return { rows: deliveryRows() };
    }
    if (text.includes('FROM "ql3"."worker_credentials"')) {
      return {
        rows: state.credential
          ? [{ version: state.credential.version, workerId: state.credential.workerId }]
          : [],
      };
    }
    if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
      state.audit = {
        eventId: params[0], requestId: params[1], operationId: params[2],
        projectId: params[3], subjectType: params[4], subjectId: params[5],
        authenticationId: params[6], outcome: params[7],
        reasons: JSON.parse(params[8]), projectVersion: params[9],
        bindingVersion: params[10], occurredAtMs: params[11],
      };
      return { rows: [] };
    }
    if (text.includes('INSERT INTO "ql3"."worker_credentials"')) {
      state.credential = {
        credentialId: params[0], version: params[1], state: params[2],
        workerId: params[3], secretDigest: params[4], createdAtMs: params[5],
        notBeforeAtMs: params[6], expiresAtMs: params[7],
      };
      return { rows: [] };
    }
    if (text.includes('INSERT INTO "ql3"."worker_credential_mutations"')) {
      state.mutation = {
        mutationId: params[0], operation: params[1], credentialId: params[2],
        credentialVersion: params[3], expectedPreviousVersion: params[4],
        changedByType: params[5], changedById: params[6], createdAtMs: params[8],
      };
      return { rows: [] };
    }
    if (text.includes('INSERT INTO "ql3"."worker_credential_deliveries"')) {
      state.deliveries.push({
        deliveryId: params[0], version: params[1], state: params[2],
        workerId: params[3], credentialId: params[4], credentialVersion: params[5],
        previousCredentialId: params[6], secretDigest: params[7],
        tokenDigest: params[8], deploymentTargetDigest: params[9],
        deploymentGeneration: params[10], stagedAtMs: params[11],
        credentialCommittedAtMs: params[12], publishedAtMs: params[13],
        publicationDigest: params[14], observedAtMs: params[15],
        observedSessionId: params[16], observedSessionVersion: params[17],
        previousRevokedAtMs: params[18],
      });
      return { rows: [] };
    }
    if (text.includes('INSERT INTO "ql3"."worker_credential_stage_discards"')) {
      state.discards.push({
        deliveryId: params[0], version: params[1], state: params[2],
        workerId: params[3], credentialId: params[4], credentialVersion: params[5],
        previousCredentialId: params[6], secretDigest: params[7],
        tokenDigest: params[8], deploymentTargetDigest: params[9],
        deploymentGeneration: params[10], stagedAtMs: params[11],
        authorizedAtMs: params[12], discardedAtMs: params[13],
      });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  }

  return {
    state,
    port: {
      query,
      async connect() {
        return {
          query,
          release() { state.releases += 1; },
        };
      },
    },
  };
}

test('commits credential, mutation and delivery v1 atomically then appends publication v2', async () => {
  const database = fakePool();
  const repository = new PostgresWorkerCredentialAdministrationRepository(database.port);
  const committed = await repository.commitDelivered({
    credential: credentialCommand(),
    delivery: delivery(),
  });
  assert.equal(committed.status, 'created');
  assert.equal(database.state.deliveries.length, 1);
  const mutationInsert = database.state.calls.findIndex((sql) =>
    sql.includes('INSERT INTO "ql3"."worker_credential_mutations"'));
  const deliveryInsert = database.state.calls.findIndex((sql) =>
    sql.includes('INSERT INTO "ql3"."worker_credential_deliveries"'));
  const commit = database.state.calls.indexOf('COMMIT');
  assert.ok(mutationInsert < deliveryInsert && deliveryInsert < commit);

  const published = await repository.markPublished({
    deliveryId: MUTATION_ID,
    expectedVersion: 1,
    publicationDigest: 'd'.repeat(64),
    publishedAtMs: 1_100,
  });
  assert.equal(published.state, 'published');
  assert.equal(database.state.deliveries.length, 2);
  const resolved = await repository.resolveDelivered(MUTATION_ID);
  assert.equal(resolved.delivery.version, 2);
  assert.equal(resolved.delivery.publicationDigest, 'd'.repeat(64));

  const replay = await repository.commitDelivered({
    credential: credentialCommand(),
    delivery: delivery(),
  });
  assert.equal(replay.status, 'existing');
  assert.equal(database.state.deliveries.length, 2);
  assert.ok(database.state.releases >= 3);
});

test('converges a lost commit response and rejects delivery semantic drift', async () => {
  const database = fakePool();
  database.state.loseFirstCommitResponse = true;
  const repository = new PostgresWorkerCredentialAdministrationRepository(database.port);
  const replay = await repository.commitDelivered({
    credential: credentialCommand(),
    delivery: delivery(),
  });
  assert.equal(replay.status, 'existing');
  assert.equal(database.state.deliveries.length, 1);
  await assert.rejects(
    repository.commitDelivered({
      credential: credentialCommand(),
      delivery: delivery({ deploymentGeneration: 'other-generation' }),
    }),
    WorkerCredentialDeliveryConflictError,
  );
  await repository.markPublished({
    deliveryId: MUTATION_ID,
    expectedVersion: 1,
    publicationDigest: 'd'.repeat(64),
    publishedAtMs: 1_100,
  });
  const publicationReplay = await repository.markPublished({
    deliveryId: MUTATION_ID,
    expectedVersion: 1,
    publicationDigest: 'd'.repeat(64),
    publishedAtMs: 1_200,
  });
  assert.equal(publicationReplay.version, 2);
  assert.equal(database.state.deliveries.length, 2);
});

test('rejects a gapped or rewritten append-only delivery history', async () => {
  const database = fakePool();
  const repository = new PostgresWorkerCredentialAdministrationRepository(database.port);
  database.state.deliveries.push(delivery({
    version: 2,
    state: 'published',
    publishedAtMs: 1_100,
    publicationDigest: 'd'.repeat(64),
  }));
  await assert.rejects(
    repository.resolveDelivery(MUTATION_ID),
    WorkerCredentialDeliveryConflictError,
  );
  database.state.deliveries.splice(
    0,
    1,
    delivery(),
    delivery({
      version: 2,
      state: 'published',
      deploymentGeneration: 'rewritten-generation',
      publishedAtMs: 1_100,
      publicationDigest: 'd'.repeat(64),
    }),
  );
  await assert.rejects(
    repository.resolveDelivery(MUTATION_ID),
    WorkerCredentialDeliveryConflictError,
  );
});

test('authorizes one exact orphan discard and permanently fences delivery commit', async () => {
  const database = fakePool();
  const repository = new PostgresWorkerCredentialAdministrationRepository(database.port);
  const authorized = await repository.authorizeStageDiscard(stageIntent());
  assert.equal(authorized.state, 'discard_authorized');
  assert.equal(authorized.authorizedAtMs, 1_100);
  assert.equal(
    (await repository.authorizeStageDiscard(stageIntent())).version,
    1,
  );
  assert.equal(database.state.discards.length, 1);
  const page = await repository.listStageDiscardRecoveryPage({ limit: 1 });
  assert.equal(page.discards[0].deliveryId, MUTATION_ID);
  assert.equal(page.truncated, false);
  const discarded = await repository.markStageDiscarded({
    deliveryId: MUTATION_ID,
    expectedVersion: 1,
  });
  assert.equal(discarded.state, 'discarded');
  assert.equal(discarded.discardedAtMs, 1_200);
  assert.equal(
    (await repository.markStageDiscarded({
      deliveryId: MUTATION_ID,
      expectedVersion: 1,
    })).version,
    2,
  );
  await assert.rejects(
    repository.commitDelivered({
      credential: credentialCommand(),
      delivery: delivery(),
    }),
    WorkerCredentialDeliveryConflictError,
  );
});

test('refuses orphan authorization after credential delivery wins', async () => {
  const database = fakePool();
  const repository = new PostgresWorkerCredentialAdministrationRepository(database.port);
  await repository.commitDelivered({
    credential: credentialCommand(),
    delivery: delivery(),
  });
  await assert.rejects(
    repository.authorizeStageDiscard(stageIntent()),
    WorkerCredentialDeliveryConflictError,
  );
  assert.equal(database.state.discards.length, 0);
});
