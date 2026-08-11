const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidSecurityAuditQueryError,
  MAX_SECURITY_AUDIT_QUERY_PAGE_SIZE,
  normalizeSecurityAuditQuery,
} = require('@qinglong/runtime-core/security-audit-query');

test('normalizes one bounded immutable audit query', () => {
  const input = {
    limit: 50,
    before: {
      occurredAtMs: 1000,
      eventId: '123e4567-e89b-42d3-a456-426614174221',
    },
    filter: {
      projectId: 'default',
      subject: { type: 'user', id: 'usr_admin' },
      outcome: 'allowed',
    },
  };
  const normalized = normalizeSecurityAuditQuery(input);
  assert.deepEqual(normalized, input);
  input.filter.subject.id = 'mutated';
  assert.equal(normalized.filter.subject.id, 'usr_admin');
});

test('rejects unbounded, malformed and widened audit queries', () => {
  for (const input of [
    { limit: 0, filter: {} },
    { limit: MAX_SECURITY_AUDIT_QUERY_PAGE_SIZE + 1, filter: {} },
    { limit: 10, filter: { projectId: '../escape' } },
    { limit: 10, filter: { subject: { type: 'unknown', id: 'id' } } },
    { limit: 10, filter: {}, unexpected: true },
  ]) {
    assert.throws(
      () => normalizeSecurityAuditQuery(input),
      InvalidSecurityAuditQueryError,
    );
  }
});
