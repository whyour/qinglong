const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalOwnerDeliveryAcknowledgementGcMutationConflictError,
  LocalOwnerDeliveryAcknowledgementGcReferenceConflictError,
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
} = require('@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc');
const {
  openLocalSqliteAcknowledgementGcDatabase,
} = require('../dist/maintenance/acknowledgementGc');
const { openLocalSqliteBootstrapDatabase } = require('../dist/storage/bootstrap');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');

const NOW = 1_760_000_000_000;
const CREDENTIAL_TTL_MS = 600_000;
const SUBJECT_ID = `usr_${Buffer.alloc(16, 31).toString('base64url')}`;
const CREDENTIAL_ID = `own_${Buffer.alloc(16, 32).toString('base64url')}`;
const ACK_MUTATION_ID = '00000000-0000-4000-8000-000000000d01';
const DELIVERY_DIGEST = 'd'.repeat(64);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-ack-gc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    profile: 'edge',
  };
}

function issuer() {
  return {
    subject: { type: 'system', id: 'owner-bootstrap' },
    authenticationId: 'local-console-test',
    authenticatedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    assurance: 'local_console',
  };
}

function gcCommand(compactedAtMs, overrides = {}) {
  const mutationId = overrides.mutationId ?? randomUUID();
  const requestId = overrides.requestId ?? `ack-gc-${mutationId}`;
  return {
    mutationId,
    requestId,
    acknowledgementMutationId: ACK_MUTATION_ID,
    expectedKind: 'credential',
    expectedDeliveryDigest: DELIVERY_DIGEST,
    bridgeClearEvidence: {
      kind: 'credential',
      acknowledgementMutationId: ACK_MUTATION_ID,
      inspectedAtMs: compactedAtMs,
      evidenceDigest: 'e'.repeat(64),
    },
    retentionPolicy: {
      version: 1,
      replayRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
      auditRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
    },
    compactedAtMs,
    audit: {
      eventId: mutationId,
      requestId,
      operationId: 'owner.delivery_acknowledgement.gc',
      projectId: null,
      subject: { type: 'system', id: 'owner-acknowledgement-gc' },
      authenticationId: 'local-owner-console',
      outcome: 'allowed',
      reasons: ['delivery_acknowledgement_gc'],
      fence: null,
      occurredAtMs: compactedAtMs,
    },
  };
}

async function readyAcknowledgement(t) {
  const options = fixture(t);
  await migrateLocalSqlitePath(options);
  const database = await openLocalSqliteBootstrapDatabase(options);
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000d91',
    pepperKeyId: 'legacy-v1',
    materialDigest: 'a'.repeat(64),
    backupDigest: 'b'.repeat(64),
    registeredAtMs: NOW - 2_000,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000d92',
    pepperKeyId: 'legacy-v1',
    expectedGeneration: 0,
    activatedAtMs: NOW - 1_000,
  });
  await database.ownerBootstrap.provision({
    mutationId: ACK_MUTATION_ID,
    requestId: 'provision-d01',
    identity: {
      subject: { type: 'user', id: SUBJECT_ID },
      status: 'active',
      version: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    credential: {
      credentialId: CREDENTIAL_ID,
      version: 1,
      pepperKeyId: 'legacy-v1',
      state: 'active',
      subject: { type: 'user', id: SUBJECT_ID },
      subjectStatus: 'active',
      secretDigest: 'c'.repeat(64),
      createdAtMs: NOW,
      notBeforeAtMs: NOW,
      expiresAtMs: NOW + CREDENTIAL_TTL_MS,
    },
    issuer: issuer(),
    audit: {
      eventId: ACK_MUTATION_ID,
      requestId: 'provision-d01',
      operationId: 'identity.bootstrap_provision',
      projectId: null,
      subject: issuer().subject,
      authenticationId: issuer().authenticationId,
      outcome: 'allowed',
      reasons: ['local_console_provisioning'],
      fence: null,
      occurredAtMs: NOW,
    },
    createdAtMs: NOW,
  });
  const acknowledgement = {
    kind: 'credential',
    mutationId: ACK_MUTATION_ID,
    requestId: 'provision-d01',
    subjectId: SUBJECT_ID,
    credentialId: CREDENTIAL_ID,
    factDigest: 'c'.repeat(64),
    deliveryDigest: DELIVERY_DIGEST,
    ttlMs: CREDENTIAL_TTL_MS,
    acknowledgedAtMs: NOW + 1,
  };
  await database.ownerBootstrap.recordDeliveryAcknowledgement(acknowledgement);
  await database.close();
  return { options, acknowledgement };
}

test('compacts one expired acknowledgement and reconstructs exact replay', async (t) => {
  const { options, acknowledgement } = await readyAcknowledgement(t);
  const compactedAtMs =
    NOW + MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS + 1_000;
  const first = await openLocalSqliteAcknowledgementGcDatabase(options);
  const second = await openLocalSqliteAcknowledgementGcDatabase(options);
  t.after(() => Promise.all([first.close(), second.close()]));
  const command = gcCommand(compactedAtMs);
  const results = await Promise.all([
    first.acknowledgementGc.compact(command),
    second.acknowledgementGc.compact(command),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    'existing',
    'inserted',
  ]);
  assert.deepEqual(
    await first.ownerBootstrap.resolveDeliveryAcknowledgement(ACK_MUTATION_ID),
    acknowledgement,
  );
  assert.equal(
    (await first.acknowledgementGc.resolveByAcknowledgement(ACK_MUTATION_ID))
      .acknowledgementSemanticDigest.length,
    64,
  );
  const client = new DatabaseSync(options.databasePath, { readOnly: true });
  assert.equal(
    client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3LocalOwnerDeliveryAcknowledgements"`,
      )
      .get().count,
    0,
  );
  assert.equal(
    client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3LocalOwnerDeliveryAcknowledgementGc"`,
      )
      .get().count,
    1,
  );
  client.close();
  await assert.rejects(
    first.acknowledgementGc.compact(
      gcCommand(compactedAtMs, { mutationId: randomUUID() }),
    ),
    LocalOwnerDeliveryAcknowledgementGcMutationConflictError,
  );
});

test('rejects compaction while the credential is still active', async (t) => {
  const { options } = await readyAcknowledgement(t);
  const database = await openLocalSqliteAcknowledgementGcDatabase(options);
  t.after(() => database.close());
  await assert.rejects(
    database.acknowledgementGc.compact(gcCommand(NOW + 2)),
    LocalOwnerDeliveryAcknowledgementGcReferenceConflictError,
  );
  assert.equal(
    await database.acknowledgementGc.resolveByAcknowledgement(ACK_MUTATION_ID),
    null,
  );
  assert.equal(
    (
      await database.ownerBootstrap.resolveDeliveryAcknowledgement(
        ACK_MUTATION_ID,
      )
    ).deliveryDigest,
    DELIVERY_DIGEST,
  );
});
