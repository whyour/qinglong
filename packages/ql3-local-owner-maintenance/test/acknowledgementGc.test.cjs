const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  openLocalSqliteBootstrapDatabase,
} = require('@qinglong/local-sqlite/bootstrap');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
} = require('@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc');
const {
  LocalOwnerDeliveryAcknowledgementGcConfigurationError,
  openLocalOwnerDeliveryAcknowledgementGc,
} = require('../dist/security-maintenance/acknowledgementGc');

const NOW = 1_760_000_000_000;
const ACK_MUTATION_ID = '00000000-0000-4000-8000-000000000e01';
const GC_MUTATION_ID = '00000000-0000-4000-8000-000000000e02';
const DELIVERY_DIGEST = 'd'.repeat(64);
const POLICY = Object.freeze({
  version: 1,
  replayRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
  auditRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
});
const COMPACTED_AT_MS =
  NOW + MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS + 1_000;

function request(overrides = {}) {
  return {
    mutationId: GC_MUTATION_ID,
    requestId: 'ack-gc-e02',
    acknowledgementMutationId: ACK_MUTATION_ID,
    expectedKind: 'credential',
    expectedDeliveryDigest: DELIVERY_DIGEST,
    ...overrides,
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-ack-gc-e2e-'));
  const secretDeliveryDirectory = path.join(root, 'secrets');
  const databasePath = path.join(root, 'qinglong3.sqlite');
  fs.mkdirSync(secretDeliveryDirectory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databaseOptions = { databasePath, profile: 'edge' };
  await migrateLocalSqlitePath(databaseOptions);
  const database = await openLocalSqliteBootstrapDatabase(databaseOptions);
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000e91',
    pepperKeyId: 'legacy-v1',
    materialDigest: 'a'.repeat(64),
    backupDigest: 'b'.repeat(64),
    registeredAtMs: NOW - 2_000,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000e92',
    pepperKeyId: 'legacy-v1',
    expectedGeneration: 0,
    activatedAtMs: NOW - 1_000,
  });
  const subjectId = `usr_${Buffer.alloc(16, 41).toString('base64url')}`;
  const credentialId = `own_${Buffer.alloc(16, 42).toString('base64url')}`;
  await database.ownerBootstrap.provision({
    mutationId: ACK_MUTATION_ID,
    requestId: 'provision-e01',
    identity: {
      subject: { type: 'user', id: subjectId },
      status: 'active',
      version: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    credential: {
      credentialId,
      version: 1,
      pepperKeyId: 'legacy-v1',
      state: 'active',
      subject: { type: 'user', id: subjectId },
      subjectStatus: 'active',
      secretDigest: 'c'.repeat(64),
      createdAtMs: NOW,
      notBeforeAtMs: NOW,
      expiresAtMs: NOW + 600_000,
    },
    issuer: {
      subject: { type: 'system', id: 'owner-bootstrap' },
      authenticationId: 'local-console-test',
      authenticatedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
      assurance: 'local_console',
    },
    audit: {
      eventId: ACK_MUTATION_ID,
      requestId: 'provision-e01',
      operationId: 'identity.bootstrap_provision',
      projectId: null,
      subject: { type: 'system', id: 'owner-bootstrap' },
      authenticationId: 'local-console-test',
      outcome: 'allowed',
      reasons: ['local_console_provisioning'],
      fence: null,
      occurredAtMs: NOW,
    },
    createdAtMs: NOW,
  });
  await database.ownerBootstrap.recordDeliveryAcknowledgement({
    kind: 'credential',
    mutationId: ACK_MUTATION_ID,
    requestId: 'provision-e01',
    subjectId,
    credentialId,
    factDigest: 'c'.repeat(64),
    deliveryDigest: DELIVERY_DIGEST,
    ttlMs: 600_000,
    acknowledgedAtMs: NOW + 1,
  });
  await database.close();
  return {
    databasePath,
    profile: 'edge',
    secretDeliveryDirectory,
    retentionPolicy: POLICY,
  };
}

test('derives trusted bridge evidence and replays one durable compaction', async (t) => {
  const options = await fixture(t);
  t.mock.method(Date, 'now', () => COMPACTED_AT_MS);
  const authority = await openLocalOwnerDeliveryAcknowledgementGc(options);
  t.after(() => authority.close());
  const inserted = await authority.compact(request());
  assert.equal(inserted.status, 'inserted');
  assert.equal(inserted.record.compactedAtMs, COMPACTED_AT_MS);
  assert.equal(inserted.record.bridgeClearEvidenceDigest.length, 64);
  const replay = await authority.compact(request());
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.record, inserted.record);
});

test('rejects a live file bridge and caller-controlled time', async (t) => {
  const options = await fixture(t);
  t.mock.method(Date, 'now', () => COMPACTED_AT_MS);
  fs.writeFileSync(
    path.join(
      options.secretDeliveryDirectory,
      `credential-${ACK_MUTATION_ID}.ready.json`,
    ),
    '{}',
    { mode: 0o600 },
  );
  const authority = await openLocalOwnerDeliveryAcknowledgementGc(options);
  t.after(() => authority.close());
  await assert.rejects(authority.compact(request()), /bridge is not clear/);
  await assert.rejects(
    authority.compact({ ...request(), compactedAtMs: COMPACTED_AT_MS }),
    LocalOwnerDeliveryAcknowledgementGcConfigurationError,
  );
});
