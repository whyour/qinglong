const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ApiCredentialUnavailableError,
  InvalidApiCredentialValueError,
} = require('@qinglong/runtime-core/api-credential');
const {
  PostgresApiCredentialRepository,
} = require('@qinglong/cluster-postgres/runtime');

function row(overrides = {}) {
  return {
    credentialId: 'app_primary',
    version: '2',
    state: 'active',
    subjectType: 'api_app',
    subjectId: 'app_primary',
    subjectStatus: 'active',
    pepperKeyId: 'legacy-v1',
    secretDigest: 'a'.repeat(64),
    createdAtMs: '100',
    notBeforeAtMs: '100',
    expiresAtMs: '1000',
    ...overrides,
  };
}

test('resolves only the latest normalized credential and stable subject', async () => {
  const calls = [];
  const repository = new PostgresApiCredentialRepository({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [row()] };
    },
  });
  assert.deepEqual(await repository.resolve('app_primary'), {
    credentialId: 'app_primary',
    version: 2,
    pepperKeyId: 'legacy-v1',
    state: 'active',
    subject: { type: 'api_app', id: 'app_primary' },
    subjectStatus: 'active',
    secretDigest: 'a'.repeat(64),
    createdAtMs: 100,
    notBeforeAtMs: 100,
    expiresAtMs: 1000,
  });
  assert.deepEqual(calls[0].values, ['app_primary']);
  assert.match(calls[0].sql, /ORDER BY credential\.version DESC/);
  assert.match(calls[0].sql, /identity_subjects/);
});

test('returns null for unknown credentials and rejects invalid ids before SQL', async () => {
  let calls = 0;
  const repository = new PostgresApiCredentialRepository({
    async query() {
      calls += 1;
      return { rows: [] };
    },
  });
  assert.equal(await repository.resolve('unknown'), null);
  await assert.rejects(
    repository.resolve('../escape'),
    InvalidApiCredentialValueError,
  );
  assert.equal(calls, 1);
});

test('fails closed on corrupt rows and database errors', async () => {
  for (const query of [
    async () => ({ rows: [row({ secretDigest: 'corrupt' })] }),
    async () => {
      throw new Error('driver detail');
    },
  ]) {
    const repository = new PostgresApiCredentialRepository({ query });
    await assert.rejects(
      repository.resolve('app_primary'),
      ApiCredentialUnavailableError,
    );
  }
});
