const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidLocalSecretError,
  LOCAL_SECRET_ALGORITHM,
  MAX_LOCAL_SECRET_PLAINTEXT_BYTES,
  createLocalSecretRef,
  localSecretBinary,
  localSecretEnvelopeAad,
  normalizeLocalSecretEnvelope,
  parseLocalSecretRef,
} = require('../dist/secret/localSecret');

test('local Secret references are canonical, exact-shape Project capabilities', () => {
  const current = createLocalSecretRef({ projectId: 'project-1', name: 'TOKEN' });
  const historical = createLocalSecretRef({
    projectId: 'project-1',
    name: 'TOKEN',
    version: 7,
  });

  assert.deepEqual(parseLocalSecretRef(current), {
    projectId: 'project-1',
    name: 'TOKEN',
  });
  assert.deepEqual(parseLocalSecretRef(historical), {
    projectId: 'project-1',
    name: 'TOKEN',
    version: 7,
  });
  assert.equal(Object.isFrozen(parseLocalSecretRef(current)), true);

  const unknownField = `qlsecret:v1:${Buffer.from(
    JSON.stringify({ projectId: 'project-1', name: 'TOKEN', scope: 'global' }),
  ).toString('base64url')}`;
  const reordered = `qlsecret:v1:${Buffer.from(
    JSON.stringify({ name: 'TOKEN', projectId: 'project-1' }),
  ).toString('base64url')}`;
  assert.throws(() => parseLocalSecretRef(unknownField), InvalidLocalSecretError);
  assert.throws(() => parseLocalSecretRef(reordered), InvalidLocalSecretError);
  assert.throws(
    () => createLocalSecretRef({ projectId: 'project-1', name: 'TOKEN', extra: true }),
    InvalidLocalSecretError,
  );
});

test('local Secret binary fields and envelopes enforce bounded exact contracts', () => {
  const envelope = {
    projectId: 'project-1',
    name: 'TOKEN',
    version: 1,
    mutationId: 'mutation-1',
    keyId: 'key-1',
    algorithm: LOCAL_SECRET_ALGORITHM,
    nonce: Buffer.alloc(12, 1).toString('base64url'),
    ciphertext: Buffer.from('secret').toString('base64url'),
    authTag: Buffer.alloc(16, 2).toString('base64url'),
    createdAtMs: 1,
  };

  const normalized = normalizeLocalSecretEnvelope(envelope);
  assert.deepEqual(normalized, envelope);
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(
    () => normalizeLocalSecretEnvelope({ ...envelope, plaintext: 'secret' }),
    InvalidLocalSecretError,
  );
  assert.throws(
    () => localSecretBinary('nonce', Buffer.alloc(11).toString('base64url')),
    InvalidLocalSecretError,
  );
  assert.throws(
    () =>
      localSecretBinary(
        'ciphertext',
        Buffer.alloc(MAX_LOCAL_SECRET_PLAINTEXT_BYTES + 1).toString('base64url'),
      ),
    InvalidLocalSecretError,
  );
});

test('local Secret AAD is stable and binds every routing and version fact', () => {
  const facts = {
    projectId: 'project-1',
    name: 'TOKEN',
    version: 3,
    mutationId: 'mutation-3',
    keyId: 'key-2',
    algorithm: LOCAL_SECRET_ALGORITHM,
  };
  assert.equal(
    localSecretEnvelopeAad(facts).toString('utf8'),
    '{"projectId":"project-1","name":"TOKEN","version":3,"mutationId":"mutation-3","keyId":"key-2","algorithm":"aes-256-gcm"}',
  );
  assert.notDeepEqual(
    localSecretEnvelopeAad(facts),
    localSecretEnvelopeAad({ ...facts, projectId: 'project-2' }),
  );
});
