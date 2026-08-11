const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  API_CREDENTIAL_SUBJECT_TYPES,
  InvalidApiCredentialValueError,
  assertApiCredentialId,
  normalizeApiCredentialRecord,
} = require('@qinglong/runtime-core/api-credential');

function record(overrides = {}) {
  return {
    credentialId: 'app_primary',
    version: 2,
    pepperKeyId: 'legacy-v1',
    state: 'active',
    subject: { type: 'api_app', id: 'app_primary' },
    subjectStatus: 'active',
    secretDigest: 'a'.repeat(64),
    createdAtMs: 100,
    notBeforeAtMs: 100,
    expiresAtMs: 1_000,
    ...overrides,
  };
}

test('normalizes one immutable API credential without secret material', () => {
  const source = record();
  const normalized = normalizeApiCredentialRecord(source);
  source.subject.id = 'mutated';
  assert.deepEqual(normalized, record());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.subject), true);
  assert.deepEqual(API_CREDENTIAL_SUBJECT_TYPES, [
    'user',
    'api_app',
    'mcp_client',
    'agent',
  ]);
  assert.equal(JSON.stringify(normalized).includes('token'), false);
});

test('rejects widened, malformed, disabled-lifetime and privileged subjects', () => {
  const invalid = [
    { ...record(), extra: true },
    record({ credentialId: '../escape' }),
    record({ version: 0 }),
    record({ pepperKeyId: '../escape' }),
    record({ state: 'unknown' }),
    record({ subject: { type: 'system', id: 'system' } }),
    record({ subject: { type: 'worker', id: 'worker-1' } }),
    record({ subjectStatus: 'unknown' }),
    record({ secretDigest: 'A'.repeat(64) }),
    record({ notBeforeAtMs: 99 }),
    record({ expiresAtMs: 100 }),
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizeApiCredentialRecord(value),
      InvalidApiCredentialValueError,
    );
  }
  assert.throws(
    () => assertApiCredentialId(''),
    InvalidApiCredentialValueError,
  );
});
