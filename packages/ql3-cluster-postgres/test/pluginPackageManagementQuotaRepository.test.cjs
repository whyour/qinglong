const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresPluginPackageManagementQuotaRepository,
} = require('../dist/entrypoints/packageManager');
const {
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-management');

function command(overrides = {}) {
  return {
    projectId: 'default',
    subject: { type: 'user', id: 'cluster-reviewer' },
    operation: 'plugin-package.inspect',
    idempotencyKey: 'inspection-1',
    ...overrides,
  };
}

test('uses one database-clock UPSERT with a bounded in-row replay ledger', async () => {
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      return {
        rows: [
          {
            admitted: true,
            consumedCount: '1',
            resetAtMs: '60000',
            observedAtMs: '1',
          },
        ],
      };
    },
  };
  const repository = new PostgresPluginPackageManagementQuotaRepository(pool, {
    windowMs: 60_000,
    limits: { 'plugin-package.inspect': 2 },
  });

  assert.deepEqual(await repository.consume(command()), {
    remaining: 1,
    resetAtMs: 60_000,
    observedAtMs: 1,
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /clock_timestamp\(\)/);
  assert.match(queries[0].text, /ON CONFLICT/);
  assert.match(queries[0].text, /receipt_ids \? \$5::text/);
  assert.match(queries[0].text, /jsonb_build_array\(\$5::text\)/);
  assert.doesNotMatch(queries[0].text, /\bBEGIN\b|\bCOMMIT\b/);
  assert.deepEqual(queries[0].values, [
    'default',
    'user',
    'cluster-reviewer',
    'plugin-package.inspect',
    'inspection-1',
    60_000,
    2,
  ]);
});

test('preserves one quota unit across exact retries and exposes reset delay', async () => {
  let calls = 0;
  const repository = new PostgresPluginPackageManagementQuotaRepository(
    {
      async query() {
        calls += 1;
        return {
          rows: [
            calls <= 2
              ? {
                  admitted: true,
                  consumedCount: '1',
                  resetAtMs: '60000',
                  observedAtMs: String(calls),
                }
              : {
                  admitted: false,
                  consumedCount: '1',
                  resetAtMs: '60000',
                  observedAtMs: '1000',
                },
          ],
        };
      },
    },
    {
      limits: { 'plugin-package.inspect': 1 },
    },
  );

  assert.equal((await repository.consume(command())).remaining, 0);
  assert.equal((await repository.consume(command())).remaining, 0);
  await assert.rejects(
    repository.consume(command({ idempotencyKey: 'inspection-2' })),
    (error) =>
      error instanceof PluginPackageManagementQuotaExceededError &&
      error.retryAfterMs === 59_000,
  );
});

test('rejects widened commands and maps database failures to unavailable', async () => {
  const repository = new PostgresPluginPackageManagementQuotaRepository({
    async query() {
      throw new Error('secret database diagnostic');
    },
  });
  await assert.rejects(repository.consume(command({ extra: true })), TypeError);
  await assert.rejects(
    repository.consume(
      command({ subject: { type: 'api_app', id: 'cluster-automation' } }),
    ),
    TypeError,
  );
  await assert.rejects(
    repository.consume(command()),
    PluginPackageManagementUnavailableError,
  );
  assert.throws(
    () =>
      new PostgresPluginPackageManagementQuotaRepository(
        { query() {} },
        { limits: { 'plugin-package.inspect': 1_001 } },
      ),
    TypeError,
  );
});
