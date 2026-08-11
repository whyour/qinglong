const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresPluginPackagePromptOutputKeyRotationRepository,
} = require('../dist/prompt-output/storage/postgresPluginPackagePromptOutputKeyRotationRepository.js');

function preparationRow(value) {
  return {
    rotationId: value.rotationId,
    requestId: value.requestId,
    mutationId: value.mutationId,
    expectedSecretUid: value.expectedSecretUid,
    expectedActiveKeyId: value.expectedActiveKeyId,
    expectedCatalogDigest: value.expectedCatalogDigest,
    newKeyId: value.newKeyId,
    materialProof: value.materialProof,
    preparedAtMs: String(value.preparedAtMs),
    preparationDigest: value.preparationDigest,
    preparationJson: value,
  };
}

function completionRow(value) {
  return {
    rotationId: value.rotationId,
    requestId: value.requestId,
    mutationId: value.mutationId,
    preparationDigest: value.preparationDigest,
    generation: String(value.generation),
    previousActiveKeyId: value.previousActiveKeyId,
    activeKeyId: value.activeKeyId,
    catalogDigest: value.catalogDigest,
    materialProof: value.materialProof,
    completedAtMs: String(value.completedAtMs),
    completionDigest: value.completionDigest,
    completionJson: value,
  };
}

function storagePool(options = {}) {
  const queries = [];
  const preparations = new Map();
  const completions = new Map();
  let inserts = 0;
  let commitFailures = options.commitFailures ?? 0;
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes('key_rotation_preparations') && sql.includes('SELECT')) {
        const value = preparations.get(parameters[0]);
        return { rows: value ? [preparationRow(value)] : [] };
      }
      if (sql.includes('key_rotation_completions') && sql.includes('SELECT')) {
        const value = completions.get(parameters[0]);
        return { rows: value ? [completionRow(value)] : [] };
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('key_rotation_preparations')
      ) {
        if (options.conflictOnSecondSource && preparations.size > 0) {
          const error = new Error('unique source');
          error.code = '23505';
          throw error;
        }
        const value = JSON.parse(parameters[10]);
        preparations.set(value.rotationId, value);
        inserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('key_rotation_completions')
      ) {
        const value = JSON.parse(parameters[11]);
        completions.set(value.rotationId, value);
        inserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'COMMIT' && commitFailures > 0 && inserts > 0) {
        commitFailures -= 1;
        throw new Error('connection reset after durable COMMIT');
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

function request(overrides = {}) {
  return {
    rotationId: 'rotation-a',
    requestId: 'request-a',
    mutationId: 'mutation-a',
    expectedSecretUid: 'secret-uid-a',
    expectedActiveKeyId: 'key-a',
    expectedCatalogDigest: '1'.repeat(64),
    newKeyId: 'key-b',
    ...overrides,
  };
}

function state() {
  return {
    generation: 2,
    previousActiveKeyId: 'key-a',
    activeKeyId: 'key-b',
    catalogDigest: '2'.repeat(64),
    materialProof: '3'.repeat(64),
  };
}

test('PostgreSQL appends rotation prepare and completion behind one source fence', async () => {
  const pool = storagePool();
  const times = [10_000, 20_000, 30_000, 40_000];
  const repository = new PostgresPluginPackagePromptOutputKeyRotationRepository(
    {
      pool,
      now: () => times.shift(),
    },
  );
  const prepared = await repository.prepare({
    request: request(),
    materialProof: '3'.repeat(64),
  });
  assert.equal(prepared.status, 'created');
  assert.equal(prepared.preparation.preparedAtMs, 10_000);
  const prepareReplay = await repository.prepare({
    request: request(),
    materialProof: '3'.repeat(64),
  });
  assert.equal(prepareReplay.status, 'existing');

  const completed = await repository.complete({
    preparation: prepared.preparation,
    state: state(),
  });
  assert.equal(completed.status, 'created');
  assert.equal(completed.completion.completedAtMs, 30_000);
  const completionReplay = await repository.complete({
    preparation: prepared.preparation,
    state: state(),
  });
  assert.equal(completionReplay.status, 'existing');
  assert.deepEqual(await repository.find('rotation-a'), {
    preparation: prepared.preparation,
    completion: completed.completion,
  });

  const lockIndex = pool.queries.findIndex(({ sql }) =>
    sql.includes('pg_advisory_xact_lock'),
  );
  const insertIndex = pool.queries.findIndex(
    ({ sql }) =>
      sql.includes('INSERT INTO') && sql.includes('key_rotation_preparations'),
  );
  assert.equal(lockIndex >= 0 && lockIndex < insertIndex, true);
  assert.equal(
    JSON.stringify([
      ...pool.preparations.values(),
      ...pool.completions.values(),
    ]).includes(Buffer.alloc(32, 0x42).toString('base64url')),
    false,
  );
});

test('PostgreSQL durable facts resolve COMMIT response loss and source conflicts', async () => {
  const lost = storagePool({ commitFailures: 1 });
  const repository = new PostgresPluginPackagePromptOutputKeyRotationRepository(
    {
      pool: lost,
      now: () => 10_000,
    },
  );
  await assert.rejects(
    repository.prepare({ request: request(), materialProof: '3'.repeat(64) }),
    { code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_UNAVAILABLE' },
  );
  const durable = await repository.find('rotation-a');
  assert.equal(durable.preparation.rotationId, 'rotation-a');

  const competing = storagePool({ conflictOnSecondSource: true });
  const competingRepository =
    new PostgresPluginPackagePromptOutputKeyRotationRepository({
      pool: competing,
      now: () => 10_000,
    });
  await competingRepository.prepare({
    request: request(),
    materialProof: '3'.repeat(64),
  });
  await assert.rejects(
    competingRepository.prepare({
      request: request({
        rotationId: 'rotation-b',
        requestId: 'request-b',
        mutationId: 'mutation-b',
        newKeyId: 'key-c',
      }),
      materialProof: '4'.repeat(64),
    }),
    { code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_CONFLICT' },
  );
});
