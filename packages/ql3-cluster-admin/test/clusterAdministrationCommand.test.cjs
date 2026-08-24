const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createClusterAdministrationCommandRunner,
  normalizeClusterAdministrationCommand,
  publishClusterAdministrationCredentialDelivery,
} = require('@qinglong/cluster-admin/administration-command');

const PRINCIPAL = Object.freeze({
  subject: { type: 'user', id: 'security-owner' },
  authenticationId: 'assertion:security-command-1',
  authenticatedAtMs: 900,
  expiresAtMs: 2_000,
  assurance: 'multi_factor',
});
const SUBJECT = Object.freeze({ type: 'api_app', id: 'automation-client' });
const PATHS = Object.freeze({
  commandFile: '/private/command.json',
  assertionFile: '/private/assertion.jwt',
  keysetFile: '/private/keyset.json',
  pepperFile: '/private/pepper',
});

function identityCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'identity.register',
    request: {
      mutationId: '123e4567-e89b-42d3-a456-426614174301',
      requestId: 'security-identity-register-1',
      expectedCurrentVersion: 0,
      subject: SUBJECT,
    },
    ...overrides,
  };
}

function credentialCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'credential.issue',
    request: {
      mutationId: '123e4567-e89b-42d3-a456-426614174302',
      requestId: 'security-credential-issue-1',
      expectedCurrentVersion: 0,
      credentialId: 'automation-primary',
      subject: SUBJECT,
      notBeforeAtMs: 1_000,
      expiresAtMs: 2_000,
    },
    ...overrides,
  };
}

function authority(overrides = {}) {
  const calls = [];
  let closes = 0;
  const credential = {
    credentialId: 'automation-primary',
    subject: SUBJECT,
    secretDigest: 'digest',
    pepperKeyId: 'legacy-v1',
    state: 'active',
    version: 1,
    createdAtMs: 1_000,
    notBeforeAtMs: 1_000,
    expiresAtMs: 2_000,
  };
  const value = {
    administration: {
      async registerIdentity(request) {
        calls.push(['identity.register', request]);
        return {
          status: 'inserted',
          identity: {
            subject: request.subject,
            status: 'active',
            version: 1,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
          mutation: {},
        };
      },
      async enableIdentity() {
        throw new Error('unexpected enable');
      },
      async disableIdentity() {
        throw new Error('unexpected disable');
      },
      async issueCredential(request) {
        calls.push(['credential.issue', request]);
        return {
          status: 'inserted',
          credential,
          mutation: {},
          token: 'ql3c_automation-primary_private-secret',
        };
      },
      async rotateCredential() {
        throw new Error('unexpected rotate');
      },
      async revokeCredential() {
        throw new Error('unexpected revoke');
      },
    },
    audit: {
      async list(query) {
        calls.push(['audit.list', query]);
        return { records: [], nextCursor: null };
      },
    },
    async close() {
      closes += 1;
    },
    ...overrides,
  };
  return { value, calls, closes: () => closes };
}

function runner(command, authorityValue, published = []) {
  const buffers = [];
  const pepper = 'A'.repeat(43);
  const files = new Map([
    [PATHS.commandFile, `${JSON.stringify(command)}\n`],
    [PATHS.assertionFile, 'signed.assertion.value'],
    [PATHS.pepperFile, pepper],
  ]);
  const authentications = [];
  const opens = [];
  const instance = createClusterAdministrationCommandRunner({
    async openAuthority(environment, candidatePepper) {
      opens.push({ environment, pepper: candidatePepper });
      return authorityValue;
    },
    async authenticate(keysetFile, assertion) {
      authentications.push({ keysetFile, assertion });
      return PRINCIPAL;
    },
    readFile(filePath) {
      const value = files.get(filePath);
      if (value === undefined) throw new Error(`unexpected file: ${filePath}`);
      const buffer = Buffer.from(value);
      buffers.push(buffer);
      return buffer;
    },
    publishDelivery(filePath, bytes) {
      published.push({ filePath, bytes: Buffer.from(bytes) });
    },
  });
  return { instance, buffers, authentications, opens };
}

test('executes one strongly authenticated identity mutation and closes authority', async () => {
  const target = authority();
  const execution = runner(identityCommand(), target.value);

  const result = await execution.instance.run(PATHS, { deployment: 'test' });

  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'identity.register',
    status: 'inserted',
    subject: SUBJECT,
    version: 1,
    identityStatus: 'active',
  });
  assert.deepEqual(execution.authentications, [
    {
      keysetFile: PATHS.keysetFile,
      assertion: 'signed.assertion.value',
    },
  ]);
  assert.equal(execution.opens[0].pepper, 'A'.repeat(43));
  assert.equal(target.calls[0][1].principal, PRINCIPAL);
  assert.equal(target.closes(), 1);
  assert.equal(
    execution.buffers.every((value) => value.every((byte) => byte === 0)),
    true,
  );
});

test('publishes a credential token only to the private delivery boundary', async () => {
  const target = authority();
  const published = [];
  const execution = runner(credentialCommand(), target.value, published);
  const paths = { ...PATHS, deliveryFile: '/private/delivery.json' };

  const result = await execution.instance.run(paths, {});

  assert.equal(result.operation, 'credential.issue');
  assert.equal(result.status, 'inserted');
  assert.equal('token' in result, false);
  assert.deepEqual(result.delivery.fileName, 'delivery.json');
  assert.match(result.delivery.digest, /^[0-9a-f]{64}$/);
  assert.equal(published.length, 1);
  const delivery = JSON.parse(published[0].bytes.toString('utf8'));
  assert.equal(delivery.token, 'ql3c_automation-primary_private-secret');
  assert.equal(delivery.mutationId, credentialCommand().request.mutationId);
  assert.equal(target.closes(), 1);
});

test('does not recreate lost token material during exact credential replay', async () => {
  const base = authority();
  base.value.administration.issueCredential = async () => ({
    status: 'existing',
    credential: {
      credentialId: 'automation-primary',
      subject: SUBJECT,
      state: 'active',
      version: 1,
      createdAtMs: 1_000,
      notBeforeAtMs: 1_000,
      expiresAtMs: 2_000,
    },
    mutation: {},
    token: null,
  });
  const published = [];
  const execution = runner(credentialCommand(), base.value, published);

  const result = await execution.instance.run(
    { ...PATHS, deliveryFile: '/private/delivery.json' },
    {},
  );

  assert.equal(result.status, 'existing');
  assert.equal('delivery' in result, false);
  assert.deepEqual(published, []);
  assert.equal(base.closes(), 1);
});

test('revokes a credential without requiring or publishing a delivery file', async () => {
  const target = authority();
  target.value.administration.revokeCredential = async (request) => ({
    status: 'inserted',
    credential: {
      credentialId: request.credentialId,
      subject: request.subject,
      state: 'revoked',
      version: 2,
      createdAtMs: 1_000,
      notBeforeAtMs: 1_000,
      expiresAtMs: 2_000,
    },
    mutation: {},
  });
  const published = [];
  const execution = runner(
    {
      schemaVersion: 1,
      operation: 'credential.revoke',
      request: {
        mutationId: '123e4567-e89b-42d3-a456-426614174303',
        requestId: 'security-credential-revoke-1',
        expectedCurrentVersion: 1,
        credentialId: 'automation-primary',
        subject: SUBJECT,
      },
    },
    target.value,
    published,
  );

  const result = await execution.instance.run(PATHS, {});

  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'credential.revoke',
    status: 'inserted',
    subject: SUBJECT,
    credentialId: 'automation-primary',
    version: 2,
    state: 'revoked',
  });
  assert.deepEqual(published, []);
  assert.equal(target.closes(), 1);
});

test('keeps audit query bounded and rejects widened command shapes before admission', async () => {
  const query = {
    schemaVersion: 1,
    operation: 'audit.list',
    request: { limit: 25, filter: { outcome: 'allowed' } },
  };
  const target = authority();
  const execution = runner(query, target.value);
  const result = await execution.instance.run(PATHS, {});
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: 'audit.list',
    page: { records: [], nextCursor: null },
  });
  assert.deepEqual(target.calls, [
    ['audit.list', { limit: 25, filter: { outcome: 'allowed' } }],
  ]);
  assert.throws(
    () => normalizeClusterAdministrationCommand({ ...query, debug: true }),
    /command shape is invalid/,
  );
  assert.throws(
    () =>
      normalizeClusterAdministrationCommand({
        ...query,
        request: { limit: 201, filter: {} },
      }),
    /audit query is invalid/,
  );
});

test('rejects widened path authority before reading a command file', async () => {
  let reads = 0;
  const instance = createClusterAdministrationCommandRunner({
    async openAuthority() {
      throw new Error('must not open authority');
    },
    async authenticate() {
      throw new Error('must not authenticate');
    },
    readFile() {
      reads += 1;
      throw new Error('must not read');
    },
    publishDelivery() {
      throw new Error('must not publish');
    },
  });

  await assert.rejects(
    instance.run({ ...PATHS, ambientCredential: true }, {}),
    /command paths shape is invalid/,
  );
  assert.equal(reads, 0);
});

test('publishes a 0600 no-replace delivery and leaves an existing target intact', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-security-delivery-'),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'credential.json');
  const bytes = Buffer.from('{"token":"secret"}\n');

  publishClusterAdministrationCredentialDelivery(filePath, bytes);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(filePath), bytes);
  assert.throws(
    () =>
      publishClusterAdministrationCredentialDelivery(
        filePath,
        Buffer.from('{"token":"replacement"}\n'),
      ),
    /could not be published/,
  );
  assert.deepEqual(fs.readFileSync(filePath), bytes);
});
