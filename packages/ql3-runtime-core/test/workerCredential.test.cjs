const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const {
  normalizeWorkerCredentialRecord,
} = require('@qinglong/runtime-core/worker-credential');
const {
  formatWorkerCredentialToken,
  workerCredentialSecretDigest,
} = require('@qinglong/runtime-core/worker-credential-token');

const PEPPER = Buffer.alloc(32, 1).toString('base64url');
const SECRET = Buffer.alloc(32, 2).toString('base64url');

function credential(overrides = {}) {
  return {
    credentialId: 'worker_primary',
    version: 2,
    state: 'active',
    workerId: 'edge-router-1',
    secretDigest: 'a'.repeat(64),
    createdAtMs: 100,
    notBeforeAtMs: 100,
    expiresAtMs: 1_000,
    ...overrides,
  };
}

test('normalizes one immutable Worker credential without secret material', () => {
  const normalized = normalizeWorkerCredentialRecord(credential());
  assert.deepEqual(normalized, credential());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(JSON.stringify(normalized).includes(SECRET), false);

  const preapproved = credential({ notBeforeAtMs: 50 });
  assert.deepEqual(normalizeWorkerCredentialRecord(preapproved), preapproved);
});

test('derives a Worker-only digest domain and canonical ql3w token', () => {
  const expected = createHmac('sha256', Buffer.from(PEPPER, 'base64url'))
    .update(Buffer.from('qinglong-worker-credential-v1\0', 'utf8'))
    .update('worker_primary', 'utf8')
    .update('\0', 'utf8')
    .update(Buffer.from(SECRET, 'base64url'))
    .digest('hex');
  assert.equal(
    workerCredentialSecretDigest(PEPPER, 'worker_primary', SECRET),
    expected,
  );
  assert.equal(
    formatWorkerCredentialToken('worker_primary', SECRET),
    `ql3w_worker_primary_${SECRET}`,
  );
});

test('rejects widened records, unsafe identities, weak entropy and lifetimes', () => {
  for (const value of [
    { ...credential(), extra: true },
    credential({ credentialId: '../worker' }),
    credential({ workerId: '../worker' }),
    credential({ version: 0 }),
    credential({ state: 'disabled' }),
    credential({ secretDigest: 'A'.repeat(64) }),
    credential({ notBeforeAtMs: -1 }),
    credential({ expiresAtMs: 100 }),
  ]) {
    assert.throws(() => normalizeWorkerCredentialRecord(value));
  }
  assert.throws(() => workerCredentialSecretDigest('weak', 'worker_primary', SECRET));
  assert.throws(() => formatWorkerCredentialToken('worker_primary', 'weak'));
});
