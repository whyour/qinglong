const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidLocalSecurityAuditRetentionValueError,
  localSecurityAuditCompactionPayload,
} = require('@qinglong/runtime-core/local-security-audit-retention');

function record(eventId, occurredAtMs) {
  return {
    eventId,
    requestId: `request-${eventId}`,
    operationId: 'security.audit.list',
    projectId: 'default',
    subject: { type: 'user', id: 'owner-user' },
    authenticationId: 'local_security_audit:test',
    outcome: 'allowed',
    reasons: ['instance_authority_security_audit_query'],
    fence: { projectVersion: 1, bindingVersion: 1 },
    occurredAtMs,
  };
}

test('creates a deterministic domain-separated digest over the exact ordered rows', () => {
  const first = record('ba000000-0000-4000-8000-000000000001', 1_000);
  const second = record('ba000000-0000-4000-8000-000000000002', 2_000);
  const payload = localSecurityAuditCompactionPayload([first, second]);
  assert.match(payload.recordsDigest, /^[0-9a-f]{64}$/);
  assert.equal(payload.payloadBytes > 0, true);
  assert.deepEqual(
    localSecurityAuditCompactionPayload([first, second]),
    payload,
  );
  assert.notEqual(
    localSecurityAuditCompactionPayload([second, first]).recordsDigest,
    payload.recordsDigest,
  );
});

test('records an explicit empty digest without charging payload bytes', () => {
  const payload = localSecurityAuditCompactionPayload([]);
  assert.equal(payload.payloadBytes, 0);
  assert.match(payload.recordsDigest, /^[0-9a-f]{64}$/);
});

test('rejects malformed records before producing compaction evidence', () => {
  assert.throws(
    () => localSecurityAuditCompactionPayload([{}]),
    InvalidLocalSecurityAuditRetentionValueError,
  );
});
