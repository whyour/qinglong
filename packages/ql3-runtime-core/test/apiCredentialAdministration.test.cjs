const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidApiCredentialAdministrationValueError,
  REVOKED_API_CREDENTIAL_DIGEST,
  normalizeAppendApiCredentialCommand,
} = require('@qinglong/runtime-core/api-credential-administration');

function command(overrides = {}) {
  const mutation = {
    mutationId: '123e4567-e89b-42d3-a456-426614174211',
    operation: 'issue',
    credentialId: 'credential_primary',
    credentialVersion: 1,
    expectedPreviousVersion: 0,
    changedBy: { type: 'user', id: 'usr_admin' },
    createdAtMs: 100,
    ...overrides.mutation,
  };
  const credential = {
    credentialId: mutation.credentialId,
    version: mutation.credentialVersion,
    pepperKeyId: 'legacy-v1',
    state: 'active',
    subject: { type: 'api_app', id: 'app_primary' },
    subjectStatus: 'active',
    secretDigest: 'a'.repeat(64),
    createdAtMs: mutation.createdAtMs,
    notBeforeAtMs: 100,
    expiresAtMs: 1000,
    ...overrides.credential,
  };
  return {
    expectedCurrentVersion: 0,
    credential,
    mutation,
    audit: {
      eventId: mutation.mutationId,
      requestId: 'request-credential-issue',
      operationId: `credential.${mutation.operation}`,
      projectId: null,
      subject: mutation.changedBy,
      authenticationId: 'admin:usr_admin:1',
      outcome: 'allowed',
      reasons: ['credential_admin'],
      fence: null,
      occurredAtMs: mutation.createdAtMs,
      ...overrides.audit,
    },
    ...overrides.command,
  };
}

test('normalizes one atomic credential issue and audit command', () => {
  const normalized = normalizeAppendApiCredentialCommand(command());
  assert.equal(normalized.credential.version, 1);
  assert.equal(normalized.mutation.operation, 'issue');
  assert.equal(Object.isFrozen(normalized.credential), true);
});

test('normalizes a revoke without retaining the previous digest', () => {
  const input = command({
    mutation: {
      mutationId: '123e4567-e89b-42d3-a456-426614174212',
      operation: 'revoke',
      credentialVersion: 3,
      expectedPreviousVersion: 2,
      createdAtMs: 500,
    },
    credential: {
      version: 3,
      state: 'revoked',
      secretDigest: REVOKED_API_CREDENTIAL_DIGEST,
      createdAtMs: 500,
      notBeforeAtMs: 500,
      expiresAtMs: 501,
    },
    command: { expectedCurrentVersion: 2 },
  });
  assert.equal(
    normalizeAppendApiCredentialCommand(input).credential.secretDigest,
    REVOKED_API_CREDENTIAL_DIGEST,
  );
});

test('rejects unfenced, secret-retaining and audit-drifted mutations', () => {
  for (const input of [
    command({ mutation: { credentialVersion: 2 } }),
    command({ mutation: { changedBy: { type: 'agent', id: 'agent-1' } } }),
    command({ credential: { state: 'revoked' } }),
    command({ audit: { operationId: 'credential.rotate' } }),
    command({ command: { unexpected: true } }),
  ]) {
    assert.throws(
      () => normalizeAppendApiCredentialCommand(input),
      InvalidApiCredentialAdministrationValueError,
    );
  }
});
