const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const {
  ApiCredentialUnavailableError,
} = require('@qinglong/runtime-core/api-credential');
const {
  ClusterControlApiCredentialConfigurationError,
  ClusterControlApiCredentialUnavailableError,
  apiCredentialSecretDigest,
  createClusterControlApiCredentialAuthenticator,
} = require('@qinglong/cluster-control/api-credential');

const NOW = 10_000;
const PEPPER = Buffer.alloc(32, 1).toString('base64url');
const SECRET = Buffer.alloc(32, 2).toString('base64url');
const CREDENTIAL_ID = 'app_primary';

function metadata(authorization = `Bearer ql3c_${CREDENTIAL_ID}_${SECRET}`) {
  return {
    requestId: 'request-1',
    method: 'POST',
    path: '/api/v3/projects/default/runs',
    query: Object.freeze({}),
    headers: Object.freeze({ authorization }),
    signal: new AbortController().signal,
  };
}

function credential(overrides = {}) {
  return {
    credentialId: CREDENTIAL_ID,
    version: 2,
    pepperKeyId: 'legacy-v1',
    state: 'active',
    subject: { type: 'api_app', id: 'app_primary' },
    subjectStatus: 'active',
    secretDigest: apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
    createdAtMs: 1,
    notBeforeAtMs: 1,
    expiresAtMs: 100_000,
    ...overrides,
  };
}

function authenticator(value = credential(), overrides = {}) {
  return createClusterControlApiCredentialAuthenticator(
    {
      async resolve(credentialId) {
        assert.equal(credentialId, CREDENTIAL_ID);
        return value;
      },
    },
    PEPPER,
    { now: () => NOW, ...overrides },
  );
}

test('authenticates a high-entropy service bearer as a short-lived principal', async () => {
  const principal = await authenticator().authenticate(metadata());
  assert.deepEqual(principal, {
    subject: { type: 'api_app', id: 'app_primary' },
    authenticationId: 'api_credential:app_primary:2',
    authenticatedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    assurance: 'service',
  });
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(JSON.stringify(principal).includes(SECRET), false);
});

test('derives a domain-separated HMAC digest and user assurance', async () => {
  const expected = createHmac('sha256', Buffer.from(PEPPER, 'base64url'))
    .update(Buffer.from('qinglong-api-credential-v1\0', 'utf8'))
    .update(CREDENTIAL_ID, 'utf8')
    .update('\0', 'utf8')
    .update(Buffer.from(SECRET, 'base64url'))
    .digest('hex');
  assert.equal(
    apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
    expected,
  );
  const principal = await authenticator(
    credential({ subject: { type: 'user', id: 'usr_primary' } }),
  ).authenticate(metadata());
  assert.equal(principal.assurance, 'single_factor');
});

test('rejects missing, malformed, wrong, inactive and disabled credentials', async () => {
  let repositoryCalls = 0;
  const strict = createClusterControlApiCredentialAuthenticator(
    {
      async resolve() {
        repositoryCalls += 1;
        return credential();
      },
    },
    PEPPER,
    { now: () => NOW },
  );
  for (const header of [
    undefined,
    'bearer token',
    `Bearer ql3c_${CREDENTIAL_ID}_short`,
    `Bearer ql3c_${CREDENTIAL_ID}_${Buffer.alloc(32, 3).toString('base64url')}`,
  ]) {
    const request = metadata();
    request.headers = Object.freeze(
      header === undefined ? {} : { authorization: header },
    );
    assert.equal(await strict.authenticate(request), null);
  }
  assert.equal(
    repositoryCalls,
    1,
    'only a structurally valid token reaches SQL',
  );

  for (const value of [
    credential({ state: 'revoked' }),
    credential({ subjectStatus: 'disabled' }),
    credential({ notBeforeAtMs: NOW + 1 }),
    credential({ expiresAtMs: NOW }),
    null,
  ]) {
    assert.equal(await authenticator(value).authenticate(metadata()), null);
  }
});

test('maps storage, corrupt record and cancellation failures to unavailable', async () => {
  const unavailable = createClusterControlApiCredentialAuthenticator(
    {
      async resolve() {
        throw new ApiCredentialUnavailableError();
      },
    },
    PEPPER,
    { now: () => NOW },
  );
  await assert.rejects(
    unavailable.authenticate(metadata()),
    ClusterControlApiCredentialUnavailableError,
  );
  await assert.rejects(
    authenticator(credential({ secretDigest: 'corrupt' })).authenticate(
      metadata(),
    ),
    ClusterControlApiCredentialUnavailableError,
  );
  await assert.rejects(
    authenticator(credential({ pepperKeyId: 'other-v1' })).authenticate(
      metadata(),
    ),
    ClusterControlApiCredentialUnavailableError,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    authenticator().authenticate({ ...metadata(), signal: controller.signal }),
    ClusterControlApiCredentialUnavailableError,
  );
});

test('rejects weak pepper and unbounded principal lifetime at construction', () => {
  const repository = { async resolve() {} };
  assert.throws(
    () => createClusterControlApiCredentialAuthenticator(repository, 'weak'),
    ClusterControlApiCredentialConfigurationError,
  );
  assert.throws(
    () =>
      createClusterControlApiCredentialAuthenticator(repository, PEPPER, {
        principalTtlMs: 300_001,
      }),
    ClusterControlApiCredentialConfigurationError,
  );
});
