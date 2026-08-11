const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LocalSecurityAuditRetentionAuthorizationError,
  LocalSecurityAuditRetentionConfigurationError,
  createLocalSecurityAuditRetentionService,
} = require('@qinglong/local-admin/security-audit-retention');
const {
  LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
} = require('@qinglong/runtime-core/local-security-audit-retention');

const NOW = 4_000_000_000;
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-user' }),
  authenticationId: 'local_security_audit:test',
  authenticatedAtMs: NOW - 1_000,
  expiresAtMs: NOW + 60_000,
  assurance: 'local_console',
});

function projectPolicy(role = 'owner') {
  return {
    async resolve(projectId, subject) {
      return {
        project: {
          id: projectId,
          name: 'Default',
          slug: 'default',
          status: 'active',
          version: 4,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
        binding: {
          projectId,
          subject,
          version: 7,
          state: 'active',
          role,
          mutationId: 'owner-binding',
          changedBy: subject,
          createdAtMs: 0,
        },
      };
    },
    async append() {
      throw new Error('not used');
    },
  };
}

function request(overrides = {}) {
  return {
    authorityProjectId: 'default',
    retentionMs: MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
    eligibleBeforeMs: NOW - MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
    limit: 64,
    mutationId: 'a1000000-0000-4000-8000-000000000001',
    requestId: 'audit-compact-1',
    failureAuditEventId: 'a1000000-0000-4000-8000-000000000002',
    principal: PRINCIPAL,
    ...overrides,
  };
}

test('authorizes an instance Owner and binds the exact retention command', async () => {
  let command;
  const repository = {
    async resolveCompaction() {
      return null;
    },
    async compactAuthorized(value) {
      command = value;
      return {
        status: 'inserted',
        record: {
          mutationId: value.mutationId,
          requestId: value.requestId,
          authorityProjectId: value.authorization.authorityProjectId,
          retentionMs: value.retentionMs,
          eligibleBeforeMs: value.eligibleBeforeMs,
          batchLimit: value.limit,
          deletedCount: 0,
          deletedPayloadBytes: 0,
          first: null,
          last: null,
          recordsDigest: 'a'.repeat(64),
          createdAtMs: value.audit.occurredAtMs,
        },
        audit: value.audit,
      };
    },
    async record() {
      throw new Error('not used');
    },
  };
  const service = createLocalSecurityAuditRetentionService(
    projectPolicy(),
    repository,
    { now: () => NOW },
  );
  const result = await service.compact(request());
  assert.equal(result.status, 'inserted');
  assert.deepEqual(command.authorization, {
    authorityProjectId: 'default',
    actor: PRINCIPAL.subject,
    fence: { projectVersion: 4, bindingVersion: 7 },
  });
  assert.deepEqual(command.audit, {
    eventId: request().mutationId,
    requestId: request().requestId,
    operationId: 'security.audit.compact',
    projectId: 'default',
    subject: PRINCIPAL.subject,
    authenticationId: PRINCIPAL.authenticationId,
    outcome: 'allowed',
    reasons: ['instance_authority_security_audit_compaction'],
    fence: { projectVersion: 4, bindingVersion: 7 },
    occurredAtMs: NOW,
  });
});

test('rejects an unsafe retention fence and oversized batch before repository access', async () => {
  let accessed = false;
  const service = createLocalSecurityAuditRetentionService(
    projectPolicy(),
    {
      async resolveCompaction() {
        accessed = true;
      },
      async compactAuthorized() {
        accessed = true;
      },
      async record() {
        accessed = true;
      },
    },
    { now: () => NOW },
  );
  await assert.rejects(
    service.compact(
      request({
        eligibleBeforeMs: NOW - MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS + 1,
      }),
    ),
    LocalSecurityAuditRetentionConfigurationError,
  );
  await assert.rejects(
    service.compact(request({ limit: 513 })),
    LocalSecurityAuditRetentionConfigurationError,
  );
  assert.equal(accessed, false);
});

test('records denial with the failure identity for a non-Owner', async () => {
  const audits = [];
  let compacted = false;
  const service = createLocalSecurityAuditRetentionService(
    projectPolicy('viewer'),
    {
      async resolveCompaction() {
        return null;
      },
      async compactAuthorized() {
        compacted = true;
        throw new Error('must not run');
      },
      async record(audit) {
        audits.push(audit);
      },
    },
    { now: () => NOW },
  );
  await assert.rejects(
    service.compact(request()),
    LocalSecurityAuditRetentionAuthorizationError,
  );
  assert.equal(compacted, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventId, request().failureAuditEventId);
  assert.equal(audits[0].outcome, 'denied');
  assert.deepEqual(audits[0].reasons, ['permission_missing']);
});

test('preserves the final credential and authority fence conflict', async () => {
  const service = createLocalSecurityAuditRetentionService(
    projectPolicy(),
    {
      async resolveCompaction() {
        return null;
      },
      async compactAuthorized() {
        throw new LocalSecurityAuditRetentionAuthorizationFenceConflictError();
      },
      async record() {},
    },
    { now: () => NOW },
  );
  await assert.rejects(
    service.compact(request()),
    LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  );
});
