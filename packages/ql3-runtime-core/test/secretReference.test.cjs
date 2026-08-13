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
const {
  secretProjectionFileName,
} = require('@qinglong/runtime-core/secret-projection');

test('keeps qlsecret:v1 profile-neutral and byte-compatible with local aliases', () => {
  const reference = { projectId: 'default', name: 'TOKEN', version: 2 };
  const value = createSecretRef(reference);
  assert.match(value, /^qlsecret:v1:/);
  assert.deepEqual(parseSecretRef(value), reference);
  assert.equal(createLocalSecretRef(reference), value);
  assert.deepEqual(parseLocalSecretRef(value), reference);
  assert.equal(Object.isFrozen(parseSecretRef(value)), true);
});

test('maps only canonical SecretRefs to stable path-free projection names', () => {
  const first = createSecretRef({
    projectId: 'default',
    name: 'TOKEN',
    version: 2,
  });
  const second = createSecretRef({
    projectId: 'default',
    name: 'TOKEN',
    version: 3,
  });
  assert.match(secretProjectionFileName(first), /^[0-9a-f]{64}$/);
  assert.equal(
    secretProjectionFileName(first),
    secretProjectionFileName(first),
  );
  assert.notEqual(
    secretProjectionFileName(first),
    secretProjectionFileName(second),
  );
  assert.throws(
    () => secretProjectionFileName('not-a-secret-ref'),
    InvalidSecretReferenceError,
  );
});

test('rejects non-canonical, cross-shape and unbounded Secret references', () => {
  for (const value of [
    'qlsecret:v1:',
    'qlsecret:v1:***',
    'local-secret:default:TOKEN',
    `qlsecret:v1:${Buffer.from(
      '{"name":"TOKEN","projectId":"default"}',
    ).toString('base64url')}`,
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
