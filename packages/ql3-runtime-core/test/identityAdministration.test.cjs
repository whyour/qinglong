const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidIdentityAdministrationValueError,
  normalizeAppendIdentitySubjectCommand,
} = require('@qinglong/runtime-core/identity-administration');

function command(overrides = {}) {
  const mutation = {
    mutationId: '123e4567-e89b-42d3-a456-426614174201',
    operation: 'register',
    subject: { type: 'api_app', id: 'app_primary' },
    subjectVersion: 1,
    expectedPreviousVersion: 0,
    status: 'active',
    changedBy: { type: 'user', id: 'usr_admin' },
    createdAtMs: 100,
    ...overrides.mutation,
  };
  return {
    expectedCurrentVersion: 0,
    mutation,
    audit: {
      eventId: mutation.mutationId,
      requestId: 'request-identity-register',
      operationId: `identity.${mutation.operation}`,
      projectId: null,
      subject: mutation.changedBy,
      authenticationId: 'admin:usr_admin:1',
      outcome: 'allowed',
      reasons: ['identity_admin'],
      fence: null,
      occurredAtMs: mutation.createdAtMs,
      ...overrides.audit,
    },
    ...overrides.command,
  };
}

test('normalizes an auditable identity registration command', () => {
  const input = command();
  const normalized = normalizeAppendIdentitySubjectCommand(input);
  assert.deepEqual(normalized, input);
  input.mutation.subject.id = 'mutated';
  assert.equal(normalized.mutation.subject.id, 'app_primary');
  assert.equal(Object.isFrozen(normalized.mutation), true);
});

test('enforces transitions, strong actor types and audit coupling', () => {
  for (const input of [
    command({ mutation: { subjectVersion: 2 } }),
    command({ mutation: { changedBy: { type: 'agent', id: 'agent-1' } } }),
    command({ mutation: { operation: 'disable', status: 'disabled' } }),
    command({ audit: { eventId: '123e4567-e89b-42d3-a456-426614174299' } }),
    command({ command: { unexpected: true } }),
  ]) {
    assert.throws(
      () => normalizeAppendIdentitySubjectCommand(input),
      InvalidIdentityAdministrationValueError,
    );
  }
});

test('accepts a version-fenced disable command', () => {
  const input = command({
    mutation: {
      mutationId: '123e4567-e89b-42d3-a456-426614174202',
      operation: 'disable',
      subjectVersion: 3,
      expectedPreviousVersion: 2,
      status: 'disabled',
    },
    command: { expectedCurrentVersion: 2 },
  });
  assert.equal(
    normalizeAppendIdentitySubjectCommand(input).mutation.subjectVersion,
    3,
  );
});
