const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  SecurityAuditUnavailableError,
} = require('@qinglong/runtime-core/security-audit');
const {
  PostgresSecurityAuditRepository,
} = require('@qinglong/cluster-postgres/runtime');

function record(overrides = {}) {
  return {
    eventId: '123e4567-e89b-42d3-a456-426614174000',
    requestId: 'request-1',
    operationId: 'run.create',
    projectId: 'default',
    subject: { type: 'user', id: 'usr_primary' },
    authenticationId: 'api_credential:primary:1',
    outcome: 'allowed',
    reasons: ['role_grant'],
    fence: { projectVersion: 2, bindingVersion: 3 },
    occurredAtMs: 1000,
    ...overrides,
  };
}

test('inserts one normalized low-sensitive audit fact without reading it back', async () => {
  const calls = [];
  const repository = new PostgresSecurityAuditRepository({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  });
  await repository.record(record());
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^INSERT INTO "ql3"\."security_audit_events"/);
  assert.deepEqual(calls[0].values, [
    '123e4567-e89b-42d3-a456-426614174000',
    'request-1',
    'run.create',
    'default',
    'user',
    'usr_primary',
    'api_credential:primary:1',
    'allowed',
    '["role_grant"]',
    2,
    3,
    1000,
  ]);
  assert.equal(JSON.stringify(calls).includes('secret'), false);
});

test('maps invalid facts and database failures to low-sensitive unavailable', async () => {
  let calls = 0;
  const invalid = new PostgresSecurityAuditRepository({
    async query() {
      calls += 1;
      return { rows: [] };
    },
  });
  await assert.rejects(
    invalid.record(record({ reasons: ['driver password leaked'] })),
    SecurityAuditUnavailableError,
  );
  assert.equal(calls, 0);

  const unavailable = new PostgresSecurityAuditRepository({
    async query() {
      throw new Error('driver detail');
    },
  });
  await assert.rejects(
    unavailable.record(record()),
    SecurityAuditUnavailableError,
  );
});
