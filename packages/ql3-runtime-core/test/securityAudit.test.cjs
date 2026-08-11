const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidSecurityAuditValueError,
  normalizeSecurityAuditRecord,
} = require('@qinglong/runtime-core/security-audit');

function authenticatedRecord(overrides = {}) {
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
    occurredAtMs: 1_000,
    ...overrides,
  };
}

test('normalizes an immutable low-sensitive authenticated audit fact', () => {
  const source = authenticatedRecord();
  const normalized = normalizeSecurityAuditRecord(source);
  source.subject.id = 'mutated';
  source.reasons.push('mutated');
  assert.deepEqual(normalized, authenticatedRecord());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.subject), true);
  assert.equal(Object.isFrozen(normalized.reasons), true);
  assert.equal(Object.isFrozen(normalized.fence), true);
});

test('accepts pre-authentication rejection only without identity fields', () => {
  assert.deepEqual(
    normalizeSecurityAuditRecord(
      authenticatedRecord({
        subject: null,
        authenticationId: null,
        outcome: 'authentication_rejected',
        reasons: ['authentication_rejected'],
        fence: null,
      }),
    ).outcome,
    'authentication_rejected',
  );
});

test('rejects widened, sensitive, inconsistent and malformed audit facts', () => {
  const invalid = [
    { ...authenticatedRecord(), body: { secret: true } },
    authenticatedRecord({ eventId: 'request-controlled' }),
    authenticatedRecord({ requestId: '../escape' }),
    authenticatedRecord({ operationId: 'Run Create' }),
    authenticatedRecord({ subject: null, authenticationId: null }),
    authenticatedRecord({ outcome: 'authentication_rejected' }),
    authenticatedRecord({ reasons: ['database password leaked'] }),
    authenticatedRecord({ reasons: [] }),
    authenticatedRecord({ fence: { projectVersion: 0, bindingVersion: 1 } }),
    authenticatedRecord({ occurredAtMs: -1 }),
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizeSecurityAuditRecord(value),
      InvalidSecurityAuditValueError,
    );
  }
});
