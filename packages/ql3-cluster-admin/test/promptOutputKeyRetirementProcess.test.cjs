const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  pluginPackagePromptOutputKeyRetirementAbsenceProof,
} = require('@qinglong/ai/plugin-package-prompt-output-key-retirement');
const {
  ClusterPromptOutputKeyRetirementProcessConfigError,
  runClusterPromptOutputKeyRetirementProcess,
} = require('../dist/prompt-output/key-management/promptOutputKeyRetirementProcess');

function preparationRow(value) {
  return {
    keyId: value.keyId,
    retirementId: value.retirementId,
    requestId: value.requestId,
    mutationId: value.mutationId,
    catalogDigest: value.catalogDigest,
    materialProof: value.materialProof,
    preparedAtMs: String(value.preparedAtMs),
    preparationDigest: value.preparationDigest,
    preparationJson: value,
  };
}

function completionRow(value) {
  return {
    keyId: value.keyId,
    retirementId: value.retirementId,
    requestId: value.requestId,
    mutationId: value.mutationId,
    preparationDigest: value.preparationDigest,
    retiredCatalogDigest: value.retiredCatalogDigest,
    absenceProof: value.absenceProof,
    completedAtMs: String(value.completedAtMs),
    completionDigest: value.completionDigest,
    completionJson: value,
  };
}

function databaseHarness() {
  let preparation = null;
  let completion = null;
  let closeCount = 0;
  const statements = [];
  const query = async (sql, values = []) => {
    statements.push({ sql, values });
    if (sql.includes('current_user AS "currentUser"')) {
      return {
        rows: [
          {
            currentUser: 'ql3_ai_maintenance',
            maintenanceAuthority: true,
            schemaAuthority: true,
            artifactDeleteOnly: true,
            tombstoneAppendOnly: true,
            keyRetirementAppendOnly: true,
            keyRotationAppendOnly: true,
            terminalEvidenceReadOnly: true,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('key_retirement_preparations') && sql.includes('SELECT')) {
      return {
        rows:
          preparation && preparation.keyId === values[0]
            ? [preparationRow(preparation)]
            : [],
        rowCount: preparation ? 1 : 0,
      };
    }
    if (sql.includes('key_retirement_completions') && sql.includes('SELECT')) {
      return {
        rows:
          completion && completion.keyId === values[0]
            ? [completionRow(completion)]
            : [],
        rowCount: completion ? 1 : 0,
      };
    }
    if (sql.includes('count(*)::text AS count')) {
      return { rows: [{ count: '0' }], rowCount: 1 };
    }
    if (
      sql.includes('INSERT INTO') &&
      sql.includes('key_retirement_preparations')
    ) {
      preparation = JSON.parse(values[8]);
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes('INSERT INTO') &&
      sql.includes('key_retirement_completions')
    ) {
      completion = JSON.parse(values[9]);
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith('BEGIN') ||
      sql.startsWith('SET LOCAL') ||
      sql.startsWith('SELECT pg_advisory_xact_lock') ||
      sql === 'COMMIT' ||
      sql === 'ROLLBACK'
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  const pool = {
    query,
    async connect() {
      return client;
    },
  };
  return {
    statements,
    get closeCount() {
      return closeCount;
    },
    async openDatabase() {
      return {
        pool,
        async close() {
          closeCount += 1;
        },
      };
    },
  };
}

test('retires one inactive Cluster key through maintenance PostgreSQL and injected material authority', async () => {
  const database = databaseHarness();
  const keyId = 'cluster-key-old';
  const initialCatalogDigest = '1'.repeat(64);
  const materialProof = '2'.repeat(64);
  const retiredCatalogDigest = '3'.repeat(64);
  let retiredPreparation = null;
  const materials = {
    async inspect() {
      if (retiredPreparation) {
        return {
          state: 'absent',
          keyId,
          catalogDigest: retiredCatalogDigest,
          absenceProof: pluginPackagePromptOutputKeyRetirementAbsenceProof(
            retiredPreparation,
            retiredCatalogDigest,
          ),
        };
      }
      return {
        state: 'inactive',
        keyId,
        catalogDigest: initialCatalogDigest,
        materialProof,
      };
    },
    async retire({ preparation }) {
      retiredPreparation = preparation;
      return this.inspect(keyId);
    },
  };
  const options = {
    database: { connection: { host: 'postgres.example.test' } },
    request: {
      keyId,
      retirementId: 'retirement-1',
      requestId: 'request-1',
      mutationId: 'mutation-1',
    },
    materials,
    openDatabase: database.openDatabase,
  };

  const completed = await runClusterPromptOutputKeyRetirementProcess(options);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.keyId, keyId);
  assert.equal(completed.readiness.keyRetirementAppendOnly, true);
  assert.equal(completed.readiness.keyRotationAppendOnly, true);
  assert.match(completed.preparationDigest, /^[0-9a-f]{64}$/);
  assert.match(completed.completionDigest, /^[0-9a-f]{64}$/);

  const replay = await runClusterPromptOutputKeyRetirementProcess(options);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.preparationDigest, completed.preparationDigest);
  assert.equal(replay.completionDigest, completed.completionDigest);
  assert.equal(database.closeCount, 2);
  assert.equal(
    database.statements.filter(
      ({ sql }) =>
        sql.includes('INSERT INTO') &&
        sql.includes('key_retirement_preparations'),
    ).length,
    1,
  );
  assert.equal(
    database.statements.filter(
      ({ sql }) =>
        sql.includes('INSERT INTO') &&
        sql.includes('key_retirement_completions'),
    ).length,
    1,
  );
});

test('rejects an invalid retirement request before opening PostgreSQL', async () => {
  let opened = false;
  await assert.rejects(
    runClusterPromptOutputKeyRetirementProcess({
      database: { connection: { host: 'postgres.example.test' } },
      request: {
        keyId: '../invalid',
        retirementId: 'retirement-1',
        requestId: 'request-1',
        mutationId: 'mutation-1',
      },
      materials: { async inspect() {}, async retire() {} },
      async openDatabase() {
        opened = true;
        throw new Error('must not open');
      },
    }),
    ClusterPromptOutputKeyRetirementProcessConfigError,
  );
  assert.equal(opened, false);
});
