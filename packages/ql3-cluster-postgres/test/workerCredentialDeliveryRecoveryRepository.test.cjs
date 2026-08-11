const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresWorkerCredentialAdministrationRepository,
} = require('../dist/entrypoints/admin');

const DELIVERY_ID = '123e4567-e89b-42d3-a456-426614174801';
const REVOKE_ID = '123e4567-e89b-42d3-a456-426614174802';
const SESSION_ID = '019f7094-a853-72f3-82ab-dfa08e6bd1c1';

function delivery(version, overrides = {}) {
  return {
    deliveryId: DELIVERY_ID,
    version,
    state: version === 1
      ? 'credential_committed'
      : version === 2
        ? 'published'
        : version === 3
          ? 'observed'
          : 'previous_revoked',
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
    publishedAtMs: version >= 2 ? 1_100 : null,
    publicationDigest: version >= 2 ? 'd'.repeat(64) : null,
    observedAtMs: version >= 3 ? 1_200 : null,
    observedSessionId: version >= 3 ? SESSION_ID : null,
    observedSessionVersion: version >= 3 ? 4 : null,
    previousRevokedAtMs: version >= 4 ? 1_300 : null,
    ...overrides,
  };
}

function revokeCommand() {
  return {
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
      mutationId: REVOKE_ID,
      operation: 'revoke',
      credentialId: 'worker_generation_1',
      credentialVersion: 2,
      expectedPreviousVersion: 1,
      changedBy: { type: 'system', id: 'credential-recovery' },
      createdAtMs: 1_300,
    },
    audit: {
      eventId: REVOKE_ID,
      requestId: `worker-delivery-revoke:${DELIVERY_ID}`,
      operationId: 'worker_credential.revoke',
      projectId: null,
      subject: { type: 'system', id: 'credential-recovery' },
      authenticationId: 'service:credential-recovery',
      outcome: 'allowed',
      reasons: ['worker_credential_admin'],
      fence: null,
      occurredAtMs: 1_300,
    },
  };
}

function database() {
  const deliveries = [delivery(1), delivery(2), delivery(3)];
  const calls = [];
  let revoke = null;
  let audit = null;
  const query = async (text, values = []) => {
    const sql = String(text);
    calls.push(sql);
    if (
      sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' ||
      sql.includes('set_config') || sql.includes('pg_advisory_xact_lock')
    ) return { rows: [] };
    if (sql.startsWith('WITH observation AS')) {
      const latest = deliveries.at(-1);
      if (latest.state === 'previous_revoked') {
        return { rows: [{ observedAtMs: '1400', deliveryId: null }] };
      }
      return { rows: [{
        ...latest,
        observedAtMs: '1400',
        observedAtMsDelivery: latest.observedAtMs,
      }] };
    }
    if (sql.includes('FROM "ql3"."worker_credential_mutations" AS mutation')) {
      if (!revoke || values[0] !== REVOKE_ID) return { rows: [] };
      return { rows: [{
        mutationId: revoke.mutation.mutationId,
        operation: revoke.mutation.operation,
        credentialId: revoke.mutation.credentialId,
        credentialVersion: revoke.mutation.credentialVersion,
        expectedPreviousVersion: revoke.mutation.expectedPreviousVersion,
        changedByType: revoke.mutation.changedBy.type,
        changedById: revoke.mutation.changedBy.id,
        createdAtMs: revoke.mutation.createdAtMs,
        state: revoke.credential.state,
        workerId: revoke.credential.workerId,
        secretDigest: revoke.credential.secretDigest,
        notBeforeAtMs: revoke.credential.notBeforeAtMs,
        expiresAtMs: revoke.credential.expiresAtMs,
        auditEventId: audit.eventId,
        auditRequestId: audit.requestId,
        auditOperationId: audit.operationId,
        auditProjectId: null,
        auditSubjectType: audit.subjectType,
        auditSubjectId: audit.subjectId,
        auditAuthenticationId: audit.authenticationId,
        auditOutcome: audit.outcome,
        auditReasons: audit.reasons,
        auditProjectVersion: null,
        auditBindingVersion: null,
        auditOccurredAtMs: audit.occurredAtMs,
      }] };
    }
    if (sql.includes('FROM "ql3"."worker_credential_deliveries"')) {
      return { rows: deliveries.map((value) => ({ ...value })) };
    }
    if (sql.includes('FROM "ql3"."worker_credentials"')) {
      return { rows: [{ version: 1, state: 'active', workerId: 'edge-router-1' }] };
    }
    if (sql.includes('INSERT INTO "ql3"."security_audit_events"')) {
      audit = {
        eventId: values[0], requestId: values[1], operationId: values[2],
        subjectType: values[4], subjectId: values[5],
        authenticationId: values[6], outcome: values[7],
        reasons: JSON.parse(values[8]), occurredAtMs: values[11],
      };
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "ql3"."worker_credentials"')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "ql3"."worker_credential_mutations"')) {
      revoke = { credential: revokeCommand().credential, mutation: revokeCommand().mutation };
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "ql3"."worker_credential_deliveries"')) {
      deliveries.push(delivery(4));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return {
    calls,
    deliveries,
    port: {
      query,
      async connect() { return { query, release() {} }; },
    },
  };
}

test('pages observed delivery and atomically appends revoke plus v4', async () => {
  const db = database();
  const repository = new PostgresWorkerCredentialAdministrationRepository(db.port);
  const page = await repository.listRecoveryPage({ limit: 1 });
  assert.equal(page.deliveries[0].state, 'observed');
  assert.equal(page.observedAtMs, 1_400);
  const result = await repository.revokePreviousDelivered({
    credential: revokeCommand(),
    delivery: delivery(4),
  });
  assert.equal(result.status, 'created');
  assert.equal(db.deliveries.at(-1).state, 'previous_revoked');
  const auditInsert = db.calls.findIndex((sql) =>
    sql.includes('INSERT INTO "ql3"."security_audit_events"'));
  const credentialInsert = db.calls.findIndex((sql) =>
    sql.includes('INSERT INTO "ql3"."worker_credentials"'));
  const mutationInsert = db.calls.findIndex((sql) =>
    sql.includes('INSERT INTO "ql3"."worker_credential_mutations"'));
  const deliveryInsert = db.calls.findIndex((sql) =>
    sql.includes('INSERT INTO "ql3"."worker_credential_deliveries"'));
  const commit = db.calls.lastIndexOf('COMMIT');
  assert.ok(
    auditInsert < credentialInsert &&
    credentialInsert < mutationInsert &&
    mutationInsert < deliveryInsert &&
    deliveryInsert < commit,
  );
  const replay = await repository.revokePreviousDelivered({
    credential: revokeCommand(),
    delivery: delivery(4),
  });
  assert.equal(replay.status, 'existing');
  assert.equal(db.deliveries.length, 4);
  assert.deepEqual((await repository.listRecoveryPage()).deliveries, []);
});
