const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PostgresPluginPackagePromptOutputKeyRetirementRepository,
  assertPostgresPluginPackagePromptOutputKeyNotRetiring,
} = require('../dist/prompt-output/storage/postgresPluginPackagePromptOutputKeyRetirementRepository.js');

function preparationRow(preparation) {
  return {
    keyId: preparation.keyId,
    retirementId: preparation.retirementId,
    requestId: preparation.requestId,
    mutationId: preparation.mutationId,
    catalogDigest: preparation.catalogDigest,
    materialProof: preparation.materialProof,
    preparedAtMs: String(preparation.preparedAtMs),
    preparationDigest: preparation.preparationDigest,
    preparationJson: preparation,
  };
}

function completionRow(completion) {
  return {
    keyId: completion.keyId,
    retirementId: completion.retirementId,
    requestId: completion.requestId,
    mutationId: completion.mutationId,
    preparationDigest: completion.preparationDigest,
    retiredCatalogDigest: completion.retiredCatalogDigest,
    absenceProof: completion.absenceProof,
    completedAtMs: String(completion.completedAtMs),
    completionDigest: completion.completionDigest,
    completionJson: completion,
  };
}

function storagePool(options = {}) {
  const queries = [];
  const preparations = new Map();
  const completions = new Map();
  const liveKeys = new Set(options.liveKeys ?? []);
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (
        sql.includes('key_retirement_preparations') &&
        sql.includes('SELECT')
      ) {
        const value = preparations.get(parameters[0]);
        return { rows: value ? [preparationRow(value)] : [] };
      }
      if (
        sql.includes('key_retirement_completions') &&
        sql.includes('SELECT')
      ) {
        const value = completions.get(parameters[0]);
        return { rows: value ? [completionRow(value)] : [] };
      }
      if (sql.includes('count(*)::text')) {
        return { rows: [{ count: liveKeys.has(parameters[0]) ? '1' : '0' }] };
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('key_retirement_preparations')
      ) {
        const value = JSON.parse(parameters[8]);
        preparations.set(value.keyId, value);
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('key_retirement_completions')
      ) {
        const value = JSON.parse(parameters[9]);
        completions.set(value.keyId, value);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    queries,
    preparations,
    completions,
    client,
    async connect() {
      return client;
    },
    async query(sql, parameters) {
      return client.query(sql, parameters);
    },
  };
}

function command() {
  return {
    keyId: 'cluster-key-retired',
    retirementId: 'retirement-a',
    requestId: 'request-a',
    mutationId: 'mutation-a',
    catalogDigest: '1'.repeat(64),
    materialProof: '2'.repeat(64),
  };
}

test('PostgreSQL appends key retirement facts behind a shared key fence', async () => {
  const pool = storagePool();
  const times = [10_000, 20_000, 30_000, 40_000];
  const repository =
    new PostgresPluginPackagePromptOutputKeyRetirementRepository({
      pool,
      now: () => times.shift(),
    });

  const prepared = await repository.prepare(command());
  assert.equal(prepared.status, 'created');
  assert.equal(prepared.preparation.preparedAtMs, 10_000);
  const replay = await repository.prepare(command());
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.preparation, prepared.preparation);

  const completed = await repository.complete({
    preparation: prepared.preparation,
    retiredCatalogDigest: '3'.repeat(64),
    absenceProof: '4'.repeat(64),
  });
  assert.equal(completed.status, 'created');
  assert.equal(completed.completion.completedAtMs, 30_000);
  const completionReplay = await repository.complete({
    preparation: prepared.preparation,
    retiredCatalogDigest: '3'.repeat(64),
    absenceProof: '4'.repeat(64),
  });
  assert.equal(completionReplay.status, 'existing');
  assert.deepEqual(completionReplay.completion, completed.completion);
  assert.deepEqual(await repository.find(command().keyId), {
    preparation: prepared.preparation,
    completion: completed.completion,
  });

  const lockIndex = pool.queries.findIndex(({ sql }) =>
    sql.includes('pg_advisory_xact_lock'),
  );
  const countIndex = pool.queries.findIndex(({ sql }) =>
    sql.includes('count(*)::text'),
  );
  const insertIndex = pool.queries.findIndex(
    ({ sql }) =>
      sql.includes('INSERT INTO') &&
      sql.includes('key_retirement_preparations'),
  );
  assert.equal(lockIndex >= 0, true);
  assert.equal(lockIndex < countIndex && countIndex < insertIndex, true);
  await assert.rejects(
    assertPostgresPluginPackagePromptOutputKeyNotRetiring(
      pool.client,
      command().keyId,
    ),
    { code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_CONFLICT' },
  );
});

test('PostgreSQL refuses retirement while live ciphertext exists', async () => {
  const pool = storagePool({ liveKeys: [command().keyId] });
  const repository =
    new PostgresPluginPackagePromptOutputKeyRetirementRepository({
      pool,
      now: () => 10_000,
    });
  await assert.rejects(repository.prepare(command()), {
    code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_CONFLICT',
  });
  assert.equal(pool.preparations.size, 0);
  assert.equal(
    pool.queries.some(
      ({ sql }) =>
        sql.includes('INSERT INTO') &&
        sql.includes('key_retirement_preparations'),
    ),
    false,
  );
});
