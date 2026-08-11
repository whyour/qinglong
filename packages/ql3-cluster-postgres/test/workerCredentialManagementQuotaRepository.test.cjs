const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresWorkerCredentialManagementQuotaRepository,
} = require('@qinglong/cluster-postgres/worker-credential-manager');

const command = Object.freeze({
  projectId: 'cluster-authority',
  subject: Object.freeze({ type: 'user', id: 'operator-a' }),
  operation: 'worker-credential.plan',
  idempotencyKey: 'worker-credential:worker-a:generation-2',
});

test('uses one database-clock UPSERT and exact replay receipt', async () => {
  const calls = [];
  const repository = new PostgresWorkerCredentialManagementQuotaRepository(
    {
      async query(text, values) {
        calls.push({ text, values });
        return {
          rows: [{
            admitted: true,
            consumedCount: 1,
            resetAtMs: 60_000,
            observedAtMs: 1_000,
          }],
        };
      },
    },
    { windowMs: 60_000, limits: { 'worker-credential.plan': 1 } },
  );
  assert.deepEqual(await repository.consume(command), {
    admitted: true,
    retryAfterMs: null,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /clock_timestamp\(\)/);
  assert.match(calls[0].text, /receipt_ids \? \$5::text/);
  assert.deepEqual(calls[0].values.slice(0, 5), [
    command.projectId,
    'user',
    'operator-a',
    command.operation,
    command.idempotencyKey,
  ]);
});

test('returns one bounded durable rejection without application-clock decisions', async () => {
  let calls = 0;
  const repository = new PostgresWorkerCredentialManagementQuotaRepository({
    async query(text) {
      calls += 1;
      if (text.includes('INSERT INTO')) return { rows: [] };
      return {
        rows: [{
          admitted: false,
          consumedCount: 30,
          resetAtMs: 60_000,
          observedAtMs: 59_000,
        }],
      };
    },
  });
  assert.deepEqual(await repository.consume(command), {
    admitted: false,
    retryAfterMs: 1_000,
  });
  assert.equal(calls, 2);
});

test('rejects widened operations and configuration before PostgreSQL', async () => {
  let queries = 0;
  const pool = { async query() { queries += 1; return { rows: [] }; } };
  const repository = new PostgresWorkerCredentialManagementQuotaRepository(pool);
  await assert.rejects(
    repository.consume({ ...command, operation: 'worker-credential.execute' }),
    TypeError,
  );
  assert.equal(queries, 0);
  assert.throws(
    () => new PostgresWorkerCredentialManagementQuotaRepository(pool, { windowMs: 999 }),
    TypeError,
  );
});
