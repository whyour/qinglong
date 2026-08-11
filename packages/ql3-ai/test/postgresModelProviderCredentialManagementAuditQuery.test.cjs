const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ModelProviderCredentialManagementAuditAuthorizationFenceConflictError,
  ModelProviderCredentialManagementAuditUnavailableError,
  PostgresModelProviderCredentialManagementAuditQueryRepository,
} = require('../dist/model-provider-credential/postgresModelProviderCredentialManagementAuditQuery.js');

const QUERY_ID = '219f7094-a853-4f3b-82ab-dfa08e6bd1c3';

function auditRow({
  eventId,
  requestId,
  operationId,
  occurredAtMs,
  authenticationId = 'authentication-1',
}) {
  return {
    eventId,
    requestId,
    operationId,
    projectId: 'project-a',
    subjectType: 'user',
    subjectId: 'owner-a',
    authenticationId,
    outcome: 'allowed',
    reasons: ['project_owner'],
    projectVersion: '3',
    bindingVersion: '7',
    occurredAtMs: String(occurredAtMs),
  };
}

function authorized(overrides = {}) {
  return {
    query: {
      schemaVersion: 1,
      queryId: QUERY_ID,
      requestId: 'audit-request-1',
      projectId: 'project-a',
      limit: 2,
      ...overrides,
    },
    actor: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId: QUERY_ID,
      requestId: 'audit-request-1',
      operationId: 'model_provider_credential.audit.list',
      projectId: 'project-a',
      subject: { type: 'user', id: 'owner-a' },
      authenticationId: 'authentication-1',
      outcome: 'allowed',
      reasons: ['project_owner'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: 2_000,
    },
  };
}

function fixture(options = {}) {
  const state = {
    queries: [],
    accessAudit: options.accessAudit ?? null,
    accessAuditInserts: 0,
    commitResponseLost: false,
  };
  const records = [
    auditRow({
      eventId: '319f7094-a853-4f3b-82ab-dfa08e6bd1c4',
      requestId: 'request-revoke-1',
      operationId: 'model_provider_credential.revoke',
      occurredAtMs: 1_003,
    }),
    auditRow({
      eventId: '119f7094-a853-4f3b-82ab-dfa08e6bd1c2',
      requestId: 'request-bind-2',
      operationId: 'model_provider_credential.bind',
      occurredAtMs: 1_002,
    }),
    auditRow({
      eventId: '019f7094-a853-4f3b-82ab-dfa08e6bd1c1',
      requestId: 'request-bind-1',
      operationId: 'model_provider_credential.bind',
      occurredAtMs: 1_001,
    }),
  ];
  const client = {
    async query(statement, values = []) {
      state.queries.push({ statement, values });
      if (statement.includes('FROM "ql3"."projects"')) {
        return {
          rows: [
            { status: 'active', version: String(options.projectVersion ?? 3) },
          ],
        };
      }
      if (statement.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: '7' }] };
      }
      if (
        statement.includes('FROM "ql3"."security_audit_events"') &&
        statement.includes('WHERE event_id = $1')
      ) {
        return { rows: state.accessAudit ? [state.accessAudit] : [] };
      }
      if (statement.includes('operation_id IN')) {
        return { rows: records };
      }
      if (statement.includes('INSERT INTO "ql3"."security_audit_events"')) {
        state.accessAuditInserts += 1;
        state.accessAudit = auditRow({
          eventId: values[0],
          requestId: values[1],
          operationId: values[2],
          occurredAtMs: values[11],
        });
        return { rows: [] };
      }
      if (
        statement === 'COMMIT' &&
        options.loseCommitResponse &&
        !state.commitResponseLost
      ) {
        state.commitResponseLost = true;
        const error = new Error('injected commit response loss');
        error.code = 'ECONNRESET';
        throw error;
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    state,
    repository:
      new PostgresModelProviderCredentialManagementAuditQueryRepository({
        async connect() {
          return client;
        },
      }),
  };
}

test('atomically audits and pages only content-free credential management events', async () => {
  const { repository, state } = fixture();
  const page = await repository.listAuthorized(authorized());
  assert.equal(page.projectId, 'project-a');
  assert.equal(page.records.length, 2);
  assert.deepEqual(page.nextCursor, {
    occurredAtMs: 1_002,
    eventId: '119f7094-a853-4f3b-82ab-dfa08e6bd1c2',
  });
  assert.equal(state.accessAuditInserts, 1);
  assert.match(
    state.queries.find(({ statement }) => statement.includes('operation_id IN'))
      .statement,
    /model_provider_credential\.bind[\s\S]+model_provider_credential\.revoke/,
  );
  assert.doesNotMatch(
    JSON.stringify(page),
    /secretRef|bindingDigest|transitionDigest|authenticationId|openai/i,
  );
});

test('converges an audit COMMIT response loss without duplicate access audit', async () => {
  const { repository, state } = fixture({ loseCommitResponse: true });
  await assert.rejects(
    repository.listAuthorized(authorized()),
    ModelProviderCredentialManagementAuditUnavailableError,
  );
  const replay = await repository.listAuthorized(authorized());
  assert.equal(replay.records.length, 2);
  assert.equal(state.accessAuditInserts, 1);
  assert.equal(state.commitResponseLost, true);
});

test('rejects a stale Project fence before reading or auditing events', async () => {
  const { repository, state } = fixture({ projectVersion: 4 });
  await assert.rejects(
    repository.listAuthorized(authorized()),
    ModelProviderCredentialManagementAuditAuthorizationFenceConflictError,
  );
  assert.equal(
    state.queries.some(({ statement }) =>
      statement.includes('operation_id IN'),
    ),
    false,
  );
  assert.equal(state.accessAuditInserts, 0);
});
