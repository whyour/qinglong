const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidSecretReferenceError,
  createSecretRef,
  parseSecretRef,
} = require('../dist/secret/secretReference');
const {
  createLocalSecretRef,
  parseLocalSecretRef,
} = require('../dist/secret/localSecret');

test('keeps qlsecret:v1 profile-neutral and byte-compatible with local aliases', () => {
  const reference = { projectId: 'default', name: 'TOKEN', version: 2 };
  const value = createSecretRef(reference);
  assert.match(value, /^qlsecret:v1:/);
  assert.deepEqual(parseSecretRef(value), reference);
  assert.equal(createLocalSecretRef(reference), value);
  assert.deepEqual(parseLocalSecretRef(value), reference);
  assert.equal(Object.isFrozen(parseSecretRef(value)), true);
});

test('rejects non-canonical, cross-shape and unbounded Secret references', () => {
  for (const value of [
    'qlsecret:v1:',
    'qlsecret:v1:***',
    'local-secret:default:TOKEN',
    `qlsecret:v1:${Buffer.from('{"name":"TOKEN","projectId":"default"}').toString('base64url')}`,
  ]) {
    assert.throws(() => parseSecretRef(value), InvalidSecretReferenceError);
  }
  assert.throws(
    () => createSecretRef({ projectId: 'default', name: 'TOKEN', extra: true }),
    InvalidSecretReferenceError,
  );
  assert.throws(
    () => createSecretRef({ projectId: 'x'.repeat(129), name: 'TOKEN' }),
    InvalidSecretReferenceError,
  );
});
