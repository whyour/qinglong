const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LocalSecurityAuditQueryAuthorizationError,
  LocalSecurityAuditQueryConfigurationError,
  createLocalSecurityAuditQueryService,
} = require('@qinglong/local-admin/security-audit-query');
const {
  LocalSecurityAuditQueryAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/local-security-audit-query');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-user' }),
  authenticationId: 'local_security_audit:test',
  authenticatedAtMs: 1_000,
  expiresAtMs: 61_000,
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
    query: {
      limit: 2,
      before: {
        occurredAtMs: 10_000,
        eventId: '91000000-0000-4000-8000-000000000001',
      },
      filter: {
        projectId: 'project-alpha',
        subject: { type: 'agent', id: 'planner' },
        outcome: 'denied',
      },
    },
    auditEventId: '92000000-0000-4000-8000-000000000001',
    requestId: 'audit-query-1',
    principal: PRINCIPAL,
    ...overrides,
  };
}

test('authorizes an instance Owner and preserves bounded filter/cursor semantics', async () => {
  let command;
  const repository = {
    async listAuthorized(value) {
      command = value;
      return {
        records: [
          {
            eventId: '93000000-0000-4000-8000-000000000001',
            requestId: 'denied-request',
            operationId: 'tool.invoke',
            projectId: 'project-alpha',
            subject: { type: 'agent', id: 'planner' },
            authenticationId: 'private-authentication-id',
            outcome: 'denied',
            reasons: ['permission_missing'],
            fence: { projectVersion: 2, bindingVersion: 3 },
            occurredAtMs: 9_999,
          },
        ],
        nextCursor: null,
        audit: value.audit,
      };
    },
    async record() {
      throw new Error('not used');
    },
  };
  const service = createLocalSecurityAuditQueryService(
    projectPolicy(),
    repository,
    { now: () => 2_000 },
  );
  const result = await service.list(request());
  assert.equal(result.records.length, 1);
  assert.deepEqual(command.query, request().query);
  assert.deepEqual(command.authorization, {
    authorityProjectId: 'default',
    actor: PRINCIPAL.subject,
    fence: { projectVersion: 4, bindingVersion: 7 },
  });
  assert.deepEqual(command.audit, {
    eventId: '92000000-0000-4000-8000-000000000001',
    requestId: 'audit-query-1',
    operationId: 'security.audit.list',
    projectId: 'default',
    subject: PRINCIPAL.subject,
    authenticationId: PRINCIPAL.authenticationId,
    outcome: 'allowed',
    reasons: ['instance_authority_security_audit_query'],
    fence: { projectVersion: 4, bindingVersion: 7 },
    occurredAtMs: 2_000,
  });
});

test('rejects pages above the Edge/Standalone local cap before repository access', async () => {
  let accessed = false;
  const service = createLocalSecurityAuditQueryService(
    projectPolicy(),
    {
      async listAuthorized() {
        accessed = true;
        throw new Error('must not run');
      },
      async record() {
        accessed = true;
      },
    },
    { now: () => 2_000 },
  );
  await assert.rejects(
    service.list(
      request({
        query: { limit: 65, filter: {} },
      }),
    ),
    LocalSecurityAuditQueryConfigurationError,
  );
  assert.equal(accessed, false);
});

test('records and rejects a non-Owner without exposing audit rows', async () => {
  const audits = [];
  let listed = false;
  const service = createLocalSecurityAuditQueryService(
    projectPolicy('viewer'),
    {
      async listAuthorized() {
        listed = true;
        throw new Error('must not run');
      },
      async record(audit) {
        audits.push(audit);
      },
    },
    { now: () => 2_000 },
  );
  await assert.rejects(
    service.list(request({ query: { limit: 1, filter: {} } })),
    LocalSecurityAuditQueryAuthorizationError,
  );
  assert.equal(listed, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, 'denied');
  assert.deepEqual(audits[0].reasons, ['permission_missing']);
});

test('preserves the final credential/policy TOCTOU fence conflict', async () => {
  const service = createLocalSecurityAuditQueryService(
    projectPolicy(),
    {
      async listAuthorized() {
        throw new LocalSecurityAuditQueryAuthorizationFenceConflictError();
      },
      async record() {},
    },
    { now: () => 2_000 },
  );
  await assert.rejects(
    service.list(request({ query: { limit: 1, filter: {} } })),
    LocalSecurityAuditQueryAuthorizationFenceConflictError,
  );
});
