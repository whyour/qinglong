const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalSqliteSecurityAuditQueryRepository,
} = require('@qinglong/local-sqlite/security-audit-query');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');
const {
  LocalSecurityAuditQueryAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/local-security-audit-query');

async function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-security-audit-query-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  const now = 10_000;
  client
    .prepare(
      `INSERT INTO "QingLong3Projects" (
         "id", "name", "slug", "status", "version",
         "created_at_ms", "updated_at_ms"
       ) VALUES ('project-alpha', 'Project Alpha', 'project-alpha',
                 'active', 1, ?, ?)`,
    )
    .run(now - 200, now - 200);
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
    .run('96000000-0000-4000-8000-000000000001', now - 100);
  const insertAudit = client.prepare(
    `INSERT INTO "QingLong3SecurityAuditEvents" (
       "event_id", "request_id", "operation_id", "project_id",
       "subject_type", "subject_id", "authentication_id", "outcome",
       "reasons_json", "fence_project_version", "fence_binding_version",
       "occurred_at_ms"
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [eventId, occurredAtMs, outcome, subjectId] of [
    ['97000000-0000-4000-8000-000000000003', 9_003, 'denied', 'planner'],
    ['97000000-0000-4000-8000-000000000002', 9_002, 'denied', 'planner'],
    ['97000000-0000-4000-8000-000000000001', 9_001, 'denied', 'planner'],
    ['97000000-0000-4000-8000-000000000000', 9_000, 'allowed', 'planner'],
  ]) {
    insertAudit.run(
      eventId,
      `request-${occurredAtMs}`,
      'tool.invoke',
      'project-alpha',
      'agent',
      subjectId,
      `private-auth-${occurredAtMs}`,
      outcome,
      '["policy_result"]',
      1,
      1,
      occurredAtMs,
    );
  }
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  return {
    client,
    repository: new LocalSqliteSecurityAuditQueryRepository(
      authority,
      () => {},
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

function queryAudit(eventId) {
  return {
    eventId,
    requestId: `audit-query-${eventId.at(-1)}`,
    operationId: 'security.audit.list',
    projectId: 'default',
    subject: { type: 'user', id: 'owner-user' },
    authenticationId: 'local_security_audit:test',
    outcome: 'allowed',
    reasons: ['instance_authority_security_audit_query'],
    fence: { projectVersion: 1, bindingVersion: 1 },
    occurredAtMs: 10_000 + Number(eventId.at(-1)),
  };
}

test('filters and keyset-pages a pre-audit snapshot with an exact has-more cursor', async (t) => {
  const value = await fixture(t);
  const filter = {
    projectId: 'project-alpha',
    subject: { type: 'agent', id: 'planner' },
    outcome: 'denied',
  };
  const first = await value.repository.listAuthorized({
    query: { limit: 2, filter },
    authorization: authorization(),
    audit: queryAudit('98000000-0000-4000-8000-000000000001'),
  });
  assert.deepEqual(
    first.records.map((record) => record.eventId),
    [
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000002',
    ],
  );
  assert.deepEqual(first.nextCursor, {
    occurredAtMs: 9_002,
    eventId: '97000000-0000-4000-8000-000000000002',
  });
  assert.equal(
    first.records.some(
      (record) => record.eventId === '98000000-0000-4000-8000-000000000001',
    ),
    false,
  );

  const second = await value.repository.listAuthorized({
    query: { limit: 2, before: first.nextCursor, filter },
    authorization: authorization(),
    audit: queryAudit('98000000-0000-4000-8000-000000000002'),
  });
  assert.deepEqual(
    second.records.map((record) => record.eventId),
    ['97000000-0000-4000-8000-000000000001'],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(
    value.client
      .prepare(
        `SELECT count(*) AS "count"
         FROM "QingLong3SecurityAuditEvents"
         WHERE "operation_id" = 'security.audit.list'
           AND "outcome" = 'allowed'`,
      )
      .get().count,
    2,
  );
});

test('rejects a foreign instance authority before reading or auditing rows', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    value.repository.listAuthorized({
      query: { limit: 1, filter: {} },
      authorization: authorization({
        authorityProjectId: 'project-alpha',
      }),
      audit: {
        ...queryAudit('99000000-0000-4000-8000-000000000001'),
        projectId: 'project-alpha',
      },
    }),
    LocalSecurityAuditQueryAuthorizationFenceConflictError,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT count(*) AS "count"
         FROM "QingLong3SecurityAuditEvents"
         WHERE "event_id" = ?`,
      )
      .get('99000000-0000-4000-8000-000000000001').count,
    0,
  );
});
