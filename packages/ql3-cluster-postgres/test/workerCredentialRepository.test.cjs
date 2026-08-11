const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialUnavailableError,
} = require('@qinglong/runtime-core/worker-credential');
const {
  PostgresWorkerCredentialRepository,
} = require('../dist/entrypoints/workerIngress');

function row(overrides = {}) {
  return {
    credentialId: 'worker_primary',
    version: '2',
    state: 'active',
    workerId: 'edge-1',
    secretDigest: 'a'.repeat(64),
    createdAtMs: '100',
    notBeforeAtMs: '100',
    expiresAtMs: '1000',
    ...overrides,
  };
}

test('resolves only the latest normalized Worker credential', async () => {
  const calls = [];
  const repository = new PostgresWorkerCredentialRepository({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [row(), row({ version: '1' })] };
    },
  });
  assert.deepEqual(await repository.resolve('worker_primary'), {
    credentialId: 'worker_primary',
    version: 2,
    state: 'active',
    workerId: 'edge-1',
    secretDigest: 'a'.repeat(64),
    createdAtMs: 100,
    notBeforeAtMs: 100,
    expiresAtMs: 1000,
  });
  assert.deepEqual(calls[0].values, ['worker_primary']);
  assert.match(calls[0].text, /ORDER BY version DESC/);
  assert.match(calls[0].text, /LIMIT 2/);
});

test('returns null for absence and fails closed on corrupt or unordered rows', async () => {
  const empty = new PostgresWorkerCredentialRepository({
    async query() { return { rows: [] }; },
  });
  assert.equal(await empty.resolve('worker_primary'), null);
  for (const rows of [
    [row({ secretDigest: 'corrupt' })],
    [row({ version: '1' }), row({ version: '2' })],
  ]) {
    const repository = new PostgresWorkerCredentialRepository({
      async query() { return { rows }; },
    });
    await assert.rejects(
      repository.resolve('worker_primary'),
      WorkerCredentialUnavailableError,
    );
  }
  await assert.rejects(empty.resolve('../escape'), TypeError);
});
