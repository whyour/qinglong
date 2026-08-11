const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidSecurityContractError,
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
} = require('@qinglong/runtime-core/security');

const NOW = 10_000;

test('normalizes an active principal without retaining mutable input', () => {
  const input = {
    subject: { type: 'user', id: 'usr_primary' },
    authenticationId: 'session:abc123',
    authenticatedAtMs: 9_000,
    expiresAtMs: 11_000,
    assurance: 'multi_factor',
  };
  const principal = normalizeSecurityPrincipal(input, NOW);
  input.subject.id = 'usr_changed';
  assert.deepEqual(principal, {
    subject: { type: 'user', id: 'usr_primary' },
    authenticationId: 'session:abc123',
    authenticatedAtMs: 9_000,
    expiresAtMs: 11_000,
    assurance: 'multi_factor',
  });
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(Object.isFrozen(principal.subject), true);
});

test('rejects expired, future, malformed and widened principals', () => {
  const principal = {
    subject: { type: 'worker', id: 'worker-1' },
    authenticationId: 'mtls:worker-1',
    authenticatedAtMs: 9_000,
    expiresAtMs: 11_000,
    assurance: 'service',
  };
  for (const candidate of [
    { ...principal, expiresAtMs: NOW },
    { ...principal, authenticatedAtMs: NOW + 1 },
    { ...principal, subject: { type: 'root', id: 'root' } },
    { ...principal, debug: true },
  ]) {
    assert.throws(
      () => normalizeSecurityPrincipal(candidate, NOW),
      InvalidSecurityContractError,
    );
  }
});

test('normalizes bounded policy decisions and version fences', () => {
  const input = {
    effect: 'allow',
    reasons: ['role_grant'],
    fence: { projectVersion: 3, bindingVersion: 7 },
  };
  const decision = normalizeSecurityPolicyDecision(input);
  input.reasons[0] = 'changed';
  assert.deepEqual(decision, {
    effect: 'allow',
    reasons: ['role_grant'],
    fence: { projectVersion: 3, bindingVersion: 7 },
  });
  assert.equal(Object.isFrozen(decision.reasons), true);
});

test('rejects empty or unbounded reasons and invalid fences', () => {
  for (const candidate of [
    { effect: 'deny', reasons: [], fence: null },
    { effect: 'unknown', reasons: ['unknown_effect'], fence: null },
    {
      effect: 'allow',
      reasons: ['role-grant'],
      fence: { projectVersion: 1, bindingVersion: null },
    },
    {
      effect: 'allow',
      reasons: ['role_grant'],
      fence: { projectVersion: 0, bindingVersion: null },
    },
  ]) {
    assert.throws(
      () => normalizeSecurityPolicyDecision(candidate),
      InvalidSecurityContractError,
    );
  }
});
