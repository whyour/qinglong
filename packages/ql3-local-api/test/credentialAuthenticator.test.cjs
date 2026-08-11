const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalOwnerPepperKeyringFileProvider,
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  LocalApiCredentialAuthenticationUnavailableError,
  createLocalApiCredentialAuthenticator,
} = require('../dist/authentication/credentialAuthenticator.js');

const NOW = 1_800_000_000_000;
const CREDENTIAL_ID = 'local-api-owner';
const PEPPER_KEY_ID = 'owner-pepper-v1';
const SECRET = Buffer.alloc(32, 42).toString('base64url');
const PEPPER = Buffer.alloc(32, 43).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-api-auth-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory: directory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 43),
  });
  const credential = {
    credentialId: CREDENTIAL_ID,
    version: 1,
    pepperKeyId: PEPPER_KEY_ID,
    state: 'active',
    subject: { type: 'user', id: 'user-local-api' },
    subjectStatus: 'active',
    secretDigest: apiCredentialSecretDigest(
      PEPPER,
      CREDENTIAL_ID,
      SECRET,
    ),
    createdAtMs: NOW - 1_000,
    notBeforeAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
  };
  const pepperKey = {
    pepperKeyId: PEPPER_KEY_ID,
    materialDigest: summary.digest,
    backupDigest: 'b'.repeat(64),
    state: 'active',
    version: 2,
    registeredAtMs: NOW - 2_000,
    activatedAtMs: NOW - 1_500,
  };
  const authority = {
    profile: 'edge',
    runs: {},
    apiCredentials: {
      async resolve(credentialId) {
        return credentialId === CREDENTIAL_ID ? { ...credential } : null;
      },
    },
    ownerPepper: {
      async resolveKey(pepperKeyId) {
        return pepperKeyId === PEPPER_KEY_ID ? { ...pepperKey } : null;
      },
    },
    projectPolicy: {},
    securityAudit: {},
  };
  return {
    authority,
    credential,
    pepperKey,
    provider: new LocalOwnerPepperKeyringFileProvider(directory),
  };
}

test('authenticates one exact Bearer credential and re-confirms its authority fence', async (t) => {
  const value = fixture(t);
  const authenticator = createLocalApiCredentialAuthenticator(
    value.authority,
    value.provider,
    { now: () => NOW },
  );
  assert.equal(await authenticator.authenticate(`Basic ${TOKEN}`), null);
  assert.equal(await authenticator.authenticate('Bearer malformed'), null);

  const authentication = await authenticator.authenticate(`Bearer ${TOKEN}`);
  assert.deepEqual(authentication.principal.subject, {
    type: 'user',
    id: 'user-local-api',
  });
  await authentication.confirm();
});

test('fails closed when credential or pepper authority changes after audit', async (t) => {
  const value = fixture(t);
  const authenticator = createLocalApiCredentialAuthenticator(
    value.authority,
    value.provider,
    { now: () => NOW },
  );
  const credentialRevoked = await authenticator.authenticate(`Bearer ${TOKEN}`);
  value.credential.state = 'revoked';
  await assert.rejects(
    credentialRevoked.confirm(),
    LocalApiCredentialAuthenticationUnavailableError,
  );

  value.credential.state = 'active';
  const pepperChanged = await authenticator.authenticate(`Bearer ${TOKEN}`);
  value.pepperKey.materialDigest = 'f'.repeat(64);
  await assert.rejects(
    pepperChanged.confirm(),
    LocalApiCredentialAuthenticationUnavailableError,
  );
});
