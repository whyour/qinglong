const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  establishAuthenticatedLocalCommand,
} = require('@qinglong/local-owner-console/authenticated-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

const CREDENTIAL_ID = 'package-owner';
const PEPPER_KEY_ID = 'package-owner-v1';
const PEPPER = Buffer.alloc(32, 71).toString('base64url');
const SECRET = Buffer.alloc(32, 72).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-authenticated-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 71),
  });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  fs.writeFileSync(databasePath, 'database', { mode: 0o600 });
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  let now = 10_000;
  let credential = {
    credentialId: CREDENTIAL_ID,
    version: 1,
    pepperKeyId: PEPPER_KEY_ID,
    state: 'active',
    subject: { type: 'user', id: 'owner-user' },
    subjectStatus: 'active',
    secretDigest: apiCredentialSecretDigest(
      PEPPER,
      CREDENTIAL_ID,
      SECRET,
    ),
    createdAtMs: 1,
    notBeforeAtMs: 1,
    expiresAtMs: 1_000_000,
  };
  const database = {
    apiCredentials: {
      async resolve(credentialId) {
        return credentialId === CREDENTIAL_ID ? credential : null;
      },
    },
    ownerPepper: {
      async resolveKey(pepperKeyId) {
        return pepperKeyId === PEPPER_KEY_ID
          ? {
              pepperKeyId,
              materialDigest: summary.digest,
              backupDigest: 'b'.repeat(64),
              state: 'active',
              version: 2,
              registeredAtMs: 1,
              activatedAtMs: 2,
            }
          : null;
      },
    },
  };
  return {
    database,
    options: {
      deploymentRoot,
      databasePath,
      ownerPepperKeyringDirectory,
      credentialFilePath,
      authenticationNamespace: 'local_package',
      now: () => now,
    },
    credentialFilePath,
    setNow(value) {
      now = value;
    },
    revoke() {
      credential = { ...credential, state: 'revoked', version: 2 };
    },
  };
}

test('binds a User credential to a short-lived POSIX local-console principal', async (t) => {
  const value = fixture(t);
  const authenticated = await establishAuthenticatedLocalCommand(
    value.database,
    value.options,
  );
  assert.equal(authenticated.principal.subject.type, 'user');
  assert.equal(authenticated.principal.subject.id, 'owner-user');
  assert.equal(authenticated.principal.assurance, 'local_console');
  assert.match(
    authenticated.principal.authenticationId,
    /^local_package:[0-9a-f]{64}$/,
  );
  await authenticated.confirm();
  assert.equal(JSON.stringify(authenticated).includes(TOKEN), false);
});

test('fails closed when the credential file identity or credential fence changes', async (t) => {
  const value = fixture(t);
  const authenticated = await establishAuthenticatedLocalCommand(
    value.database,
    value.options,
  );
  const replacement = `${value.credentialFilePath}.replacement`;
  fs.writeFileSync(replacement, fs.readFileSync(value.credentialFilePath), {
    mode: 0o600,
  });
  fs.renameSync(replacement, value.credentialFilePath);
  await assert.rejects(authenticated.confirm, {
    code: 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED',
  });

  const second = fixture(t);
  const fenced = await establishAuthenticatedLocalCommand(
    second.database,
    second.options,
  );
  second.revoke();
  await assert.rejects(fenced.confirm, {
    code: 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED',
  });
});

test('expires without timers and rejects non-private authority files', async (t) => {
  const value = fixture(t);
  const authenticated = await establishAuthenticatedLocalCommand(
    value.database,
    value.options,
  );
  value.setNow(70_000);
  await assert.rejects(authenticated.confirm, {
    code: 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED',
  });

  const second = fixture(t);
  fs.chmodSync(second.credentialFilePath, 0o644);
  await assert.rejects(
    establishAuthenticatedLocalCommand(second.database, second.options),
    { code: 'AUTHENTICATED_LOCAL_COMMAND_CONFIGURATION_INVALID' },
  );
});
