const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');
const {
  LocalSqliteSecurityAuditRetentionRepository,
} = require('@qinglong/local-sqlite/security-audit-retention');
const {
  LocalSecurityAuditCompactionMutationConflictError,
  LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  localSecurityAuditCompactionPayload,
} = require('@qinglong/runtime-core/local-security-audit-retention');

const NOW = 4_000_000_000;
const CUTOFF = NOW - MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS;

function audit(eventId, occurredAtMs, outcome, operationId = 'tool.invoke') {
  return {
    eventId,
    requestId: `request-${eventId}`,
    operationId,
    projectId: 'default',
    subject: { type: 'user', id: 'owner-user' },
    authenticationId: 'local_security_audit:test',
    outcome,
    reasons: ['test_reason'],
    fence: { projectVersion: 1, bindingVersion: 1 },
    occurredAtMs,
  };
}

function insertAudit(client, value) {
  client
    .prepare(
      `INSERT INTO "QingLong3SecurityAuditEvents" (
         "event_id", "request_id", "operation_id", "project_id",
         "subject_type", "subject_id", "authentication_id", "outcome",
         "reasons_json", "fence_project_version", "fence_binding_version",
         "occurred_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      value.eventId,
      value.requestId,
      value.operationId,
      value.projectId,
      value.subject.type,
      value.subject.id,
      value.authenticationId,
      value.outcome,
      JSON.stringify(value.reasons),
      value.fence.projectVersion,
      value.fence.bindingVersion,
      value.occurredAtMs,
    );
}

async function fixture(t, profile = 'edge') {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-security-audit-retention-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile });
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
         "project_id", "subject_type", "subject_id", "version", "state",
         "role", "mutation_id", "changed_by_type", "changed_by_id",
         "created_at_ms"
       ) VALUES (
         'default', 'user', 'owner-user', 1, 'active', 'owner', ?,
         'user', 'owner-user', ?
       )`,
    )
    .run('b1000000-0000-4000-8000-000000000001', NOW - 1_000);
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  return {
    client,
    repository: new LocalSqliteSecurityAuditRetentionRepository(
      authority,
      () => {},
      profile === 'edge' ? 64 : 512,
    ),
  };
}

function authorization(overrides = {}) {
  return {
    authorityProjectId: 'default',
    actor: { type: 'user', id: 'owner-user' },
    fence: { projectVersion: 1, bindingVersion: 1 },
    ...overrides,
  };
}

function command(mutationId, overrides = {}) {
  return {
    mutationId,
    requestId: `compact-${mutationId}`,
    retentionMs: MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
    eligibleBeforeMs: CUTOFF,
    limit: 64,
    authorization: authorization(),
    audit: {
      ...audit(mutationId, NOW, 'allowed', 'security.audit.compact'),
      requestId: `compact-${mutationId}`,
      reasons: ['instance_authority_security_audit_compaction'],
    },
    ...overrides,
  };
}

function existingIds(client) {
  return client
    .prepare(
      `SELECT "event_id" AS "eventId"
       FROM "QingLong3SecurityAuditEvents"
       ORDER BY "event_id"`,
    )
    .all()
    .map((row) => row.eventId);
}

test('deletes only unreferenced expired diagnostic audit and keeps an immutable receipt', async (t) => {
  const value = await fixture(t);
  const denied = audit(
    'b2000000-0000-4000-8000-000000000001',
    CUTOFF - 4,
    'denied',
  );
  const diagnostic = audit(
    'b2000000-0000-4000-8000-000000000002',
    CUTOFF - 3,
    'allowed',
    'security.audit.list',
  );
  const allowedMutation = audit(
    'b2000000-0000-4000-8000-000000000003',
    CUTOFF - 2,
    'allowed',
    'policy.project.create',
  );
  const referenced = audit(
    'b2000000-0000-4000-8000-000000000004',
    CUTOFF - 1,
    'denied',
  );
  const recent = audit(
    'b2000000-0000-4000-8000-000000000005',
    CUTOFF,
    'denied',
  );
  for (const record of [
    denied,
    diagnostic,
    allowedMutation,
    referenced,
    recent,
  ]) {
    insertAudit(value.client, record);
  }
  value.client
    .prepare(
      `INSERT INTO "QingLong3LegacyAdoptions" (
         "mutation_id", "decision_id", "project_id", "profile",
         "plan_digest", "inventory_digest", "decision_digest",
         "receipt_digest", "authorization_file_digest",
         "publication_digest", "row_count", "adopted_task_count",
         "adopted_trigger_count", "skipped_count", "audit_event_id",
         "created_at_ms"
       ) VALUES (?, ?, 'default', 'edge', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    )
    .run(
      referenced.eventId,
      'b2000000-0000-7000-8000-000000000004',
      ...Array(6).fill('a'.repeat(64)),
      referenced.eventId,
      referenced.occurredAtMs,
    );

  const mutationId = 'b3000000-0000-4000-8000-000000000001';
  const result = await value.repository.compactAuthorized(command(mutationId));
  assert.equal(result.status, 'inserted');
  assert.equal(result.record.deletedCount, 2);
  assert.deepEqual(result.record.first, {
    occurredAtMs: denied.occurredAtMs,
    eventId: denied.eventId,
  });
  assert.deepEqual(result.record.last, {
    occurredAtMs: diagnostic.occurredAtMs,
    eventId: diagnostic.eventId,
  });
  assert.deepEqual(
    {
      recordsDigest: result.record.recordsDigest,
      payloadBytes: result.record.deletedPayloadBytes,
    },
    localSecurityAuditCompactionPayload([denied, diagnostic]),
  );
  assert.deepEqual(existingIds(value.client), [
    allowedMutation.eventId,
    referenced.eventId,
    recent.eventId,
    mutationId,
  ]);
  assert.equal(
    value.client
      .prepare(
        `SELECT count(*) AS "count"
         FROM "QingLong3SecurityAuditCompactions"
         WHERE "mutation_id" = ? AND "audit_event_id" = ?`,
      )
      .get(mutationId, mutationId).count,
    1,
  );
});

test('exactly replays a batch and rejects semantic drift', async (t) => {
  const value = await fixture(t);
  insertAudit(
    value.client,
    audit('b4000000-0000-4000-8000-000000000001', CUTOFF - 1, 'denied'),
  );
  const mutationId = 'b5000000-0000-4000-8000-000000000001';
  const input = command(mutationId);
  const inserted = await value.repository.compactAuthorized(input);
  const replay = await value.repository.compactAuthorized(input);
  assert.equal(inserted.status, 'inserted');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.record, inserted.record);
  await assert.rejects(
    value.repository.compactAuthorized({
      ...input,
      requestId: 'compact-drift',
      audit: { ...input.audit, requestId: 'compact-drift' },
    }),
    LocalSecurityAuditCompactionMutationConflictError,
  );
});

test('honors the hard batch cap and advances only through fresh mutations', async (t) => {
  const value = await fixture(t);
  const firstCandidate = audit(
    'b8000000-0000-4000-8000-000000000001',
    CUTOFF - 2,
    'denied',
  );
  const secondCandidate = audit(
    'b8000000-0000-4000-8000-000000000002',
    CUTOFF - 1,
    'denied',
  );
  insertAudit(value.client, firstCandidate);
  insertAudit(value.client, secondCandidate);

  const first = await value.repository.compactAuthorized(
    command('b9000000-0000-4000-8000-000000000001', { limit: 1 }),
  );
  assert.equal(first.record.deletedCount, 1);
  assert.deepEqual(existingIds(value.client), [
    secondCandidate.eventId,
    first.record.mutationId,
  ]);

  const second = await value.repository.compactAuthorized(
    command('b9000000-0000-4000-8000-000000000002', { limit: 1 }),
  );
  assert.equal(second.record.deletedCount, 1);
  assert.deepEqual(existingIds(value.client), [
    first.record.mutationId,
    second.record.mutationId,
  ]);

  const empty = await value.repository.compactAuthorized(
    command('b9000000-0000-4000-8000-000000000003', { limit: 1 }),
  );
  assert.equal(empty.record.deletedCount, 0);
  assert.equal(empty.record.deletedPayloadBytes, 0);
  assert.equal(empty.record.first, null);
  assert.equal(empty.record.last, null);
});

test('rejects a foreign authority without deleting or writing a receipt', async (t) => {
  const value = await fixture(t);
  const candidate = audit(
    'b6000000-0000-4000-8000-000000000001',
    CUTOFF - 1,
    'denied',
  );
  insertAudit(value.client, candidate);
  const input = command('b7000000-0000-4000-8000-000000000001');
  await assert.rejects(
    value.repository.compactAuthorized({
      ...input,
      authorization: authorization({ authorityProjectId: 'foreign' }),
      audit: { ...input.audit, projectId: 'foreign' },
    }),
    LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  );
  assert.deepEqual(existingIds(value.client), [candidate.eventId]);
  assert.equal(
    value.client
      .prepare(
        `SELECT count(*) AS "count"
         FROM "QingLong3SecurityAuditCompactions"`,
      )
      .get().count,
    0,
  );
});
