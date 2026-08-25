const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PostgresApiCredentialPepperReferenceRepository,
} = require('../dist/security/apiCredentialPepperReferenceRepository.js');

test('returns bounded current pepper references using database time', async () => {
  const calls = [];
  const repository = new PostgresApiCredentialPepperReferenceRepository({
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return {
        rows: [
          { observedAtMs: '1000', credentialId: 'credential-a' },
          { observedAtMs: '1000', credentialId: 'credential-b' },
          { observedAtMs: '1000', credentialId: 'credential-c' },
        ],
      };
    },
  });

  assert.deepEqual(await repository.inspect('legacy-v1', 2), {
    pepperKeyId: 'legacy-v1',
    observedAtMs: 1000,
    credentialIds: ['credential-a', 'credential-b'],
    hasMore: true,
  });
  assert.deepEqual(calls[0].parameters, ['legacy-v1', 3]);
  assert.match(calls[0].sql, /statement_timestamp\(\)/);
  assert.match(calls[0].sql, /newer\.version > credential\.version/);
});

test('represents an empty reference set without losing database time', async () => {
  const repository = new PostgresApiCredentialPepperReferenceRepository({
    async query() {
      return { rows: [{ observedAtMs: 1000, credentialId: null }] };
    },
  });
  assert.deepEqual(await repository.inspect('retired-v1'), {
    pepperKeyId: 'retired-v1',
    observedAtMs: 1000,
    credentialIds: [],
    hasMore: false,
  });
});

test('fails closed on invalid input and malformed database rows', async () => {
  const repository = new PostgresApiCredentialPepperReferenceRepository({
    async query() {
      return { rows: [{ observedAtMs: 'invalid', credentialId: null }] };
    },
  });
  await assert.rejects(() => repository.inspect('legacy-v1'), /unavailable/);
  await assert.rejects(() => repository.inspect('legacy-v1', 65));
  await assert.rejects(() => repository.inspect('bad key'));

  for (const credentialId of [42, null, 'bad credential']) {
    const malformedRepository =
      new PostgresApiCredentialPepperReferenceRepository({
        async query() {
          return {
            rows: [
              { observedAtMs: 1000, credentialId: 'credential-a' },
              { observedAtMs: 1000, credentialId },
            ],
          };
        },
      });
    await assert.rejects(
      () => malformedRepository.inspect('legacy-v1'),
      /unavailable/,
    );
  }
});
