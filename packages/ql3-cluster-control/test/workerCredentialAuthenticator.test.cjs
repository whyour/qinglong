const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialUnavailableError,
} = require('@qinglong/runtime-core/worker-credential');
const {
  workerCredentialSecretDigest,
} = require('@qinglong/runtime-core/worker-credential-token');
const {
  createWorkerCredentialAuthenticator,
} = require('@qinglong/cluster-control/worker-ingress');

const NOW = 10_000;
const PEPPER = Buffer.alloc(32, 1).toString('base64url');
const SECRET = Buffer.alloc(32, 2).toString('base64url');
const CREDENTIAL_ID = 'worker_primary';

function metadata(authorization = `Worker ql3w_${CREDENTIAL_ID}_${SECRET}`) {
  return {
    requestId: 'request-1',
    method: 'POST',
    path: '/api/v3/worker-ingress/workers/edge-1/sessions/018f5c64-9b9d-7f1a-8c2d-1234567890ac/heartbeat',
    query: Object.freeze({}),
    headers: Object.freeze({ authorization }),
    signal: new AbortController().signal,
  };
}

function credential(overrides = {}) {
  return {
    credentialId: CREDENTIAL_ID,
    version: 2,
    state: 'active',
    workerId: 'edge-1',
    secretDigest: workerCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
    createdAtMs: 1,
    notBeforeAtMs: 1,
    expiresAtMs: 100_000,
    ...overrides,
  };
}

function authenticator(value = credential(), overrides = {}) {
  return createWorkerCredentialAuthenticator(
    { async resolve(id) { assert.equal(id, CREDENTIAL_ID); return value; } },
    PEPPER,
    { now: () => NOW, ...overrides },
  );
}

test('authenticates a ql3w credential as its bound short-lived Worker', async () => {
  assert.deepEqual(await authenticator().authenticate(metadata()), {
    workerId: 'edge-1',
    credentialId: CREDENTIAL_ID,
    credentialVersion: 2,
    authenticationId: `worker_credential:${CREDENTIAL_ID}:2`,
    authenticatedAtMs: NOW,
    expiresAtMs: 70_000,
  });
});

test('rejects malformed, mismatched, inactive and expired Worker credentials', async () => {
  let calls = 0;
  const strict = createWorkerCredentialAuthenticator(
    { async resolve() { calls += 1; return credential(); } },
    PEPPER,
    { now: () => NOW },
  );
  for (const authorization of [
    undefined,
    'Bearer ql3w_worker_primary_invalid',
    `Worker ql3w_${CREDENTIAL_ID}_${Buffer.alloc(32, 3).toString('base64url')}`,
  ]) {
    const request = metadata();
    request.headers = Object.freeze(authorization ? { authorization } : {});
    assert.equal(await strict.authenticate(request), null);
  }
  assert.equal(calls, 1);
  for (const value of [
    null,
    credential({ state: 'revoked' }),
    credential({ notBeforeAtMs: NOW + 1 }),
    credential({ expiresAtMs: NOW }),
  ]) assert.equal(await authenticator(value).authenticate(metadata()), null);
});

test('maps storage, corrupt records and cancellation to unavailable', async () => {
  const unavailable = createWorkerCredentialAuthenticator(
    { async resolve() { throw new Error('database unavailable'); } },
    PEPPER,
    { now: () => NOW },
  );
  await assert.rejects(unavailable.authenticate(metadata()), WorkerCredentialUnavailableError);
  await assert.rejects(
    authenticator(credential({ secretDigest: 'corrupt' })).authenticate(metadata()),
    WorkerCredentialUnavailableError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    authenticator().authenticate({ ...metadata(), signal: controller.signal }),
    WorkerCredentialUnavailableError,
  );
});
