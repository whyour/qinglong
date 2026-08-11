const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRotationCommand,
  normalizeToolResultKeyCatalogRecord,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  createToolResultKeyRetirementReceiptCommand,
} = require('@qinglong/runtime-core/tool-result-rekey');
const {
  PostgresToolResultRekeyRepository,
} = require('@qinglong/cluster-postgres/tool-result-rekey');

const COVERAGE_COUNT = 129;
const PAGE_SIZE = 64;
const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rotatedCatalog() {
  const bootstrap = createToolResultKeyCatalogBootstrapCommand({
    keyId: 'result-key-a',
    materialProof: toolResultKeyMaterialProof('result-key-a', KEY_A),
    mutationId: 'coverage-pressure-bootstrap-a',
  });
  const first = normalizeToolResultKeyCatalogRecord({
    ...bootstrap.next,
    committedAtMs: 1_000,
  });
  const rotation = createToolResultKeyRotationCommand(first, {
    keyId: 'result-key-b',
    materialProof: toolResultKeyMaterialProof('result-key-b', KEY_B),
    mutationId: 'coverage-pressure-rotate-b',
  });
  return normalizeToolResultKeyCatalogRecord({
    ...rotation.next,
    committedAtMs: 1_001,
  });
}

function coverageRows(catalog) {
  return Array.from({ length: COVERAGE_COUNT }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return {
      artifactId: `artifact-coverage-pressure-${suffix}`,
      bindingDigest: digest(`binding-${suffix}`),
      bindingKeyId: 'result-key-a',
      headOverlayDigest: digest(`overlay-${suffix}`),
      headTargetKeyId: 'result-key-b',
      headTargetCatalogGeneration: String(catalog.generation),
      headTargetCatalogDigest: catalog.catalogDigest,
    };
  });
}

function harness(catalog) {
  const rows = coverageRows(catalog);
  const coverageCalls = [];
  let released = 0;
  const client = {
    async query(statement, values = []) {
      if (
        statement.startsWith('BEGIN') ||
        statement === 'COMMIT' ||
        statement === 'ROLLBACK' ||
        statement.includes("set_config('") ||
        statement.includes('pg_advisory_xact_lock')
      ) {
        return { rows: [] };
      }
      if (statement.includes('tool_result_key_retirement_receipts')) {
        if (statement.startsWith('INSERT')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      }
      if (statement.includes('tool_result_key_catalog_generations')) {
        return { rows: [{ catalogJson: catalog }] };
      }
      if (
        statement.includes(
          'LEFT JOIN "ql3"."tool_execution_result_rekey_heads" AS head',
        )
      ) {
        const cursor = values[1];
        const limit = values[2];
        coverageCalls.push({ cursor, limit });
        const start = rows.findIndex((row) => row.artifactId > cursor);
        return {
          rows: start < 0 ? [] : rows.slice(start, start + limit),
        };
      }
      if (statement.includes('clock_timestamp()')) {
        return { rows: [{ now: '1700000000000' }] };
      }
      throw new Error(`unexpected SQL: ${statement}`);
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    connect: async () => client,
    query: (statement, values) => client.query(statement, values),
  };
  return {
    coverageCalls,
    released: () => released,
    repository: new PostgresToolResultRekeyRepository(pool),
  };
}

test('streams 129 covered PostgreSQL bindings through three 64-row keyset pages', async () => {
  const catalog = rotatedCatalog();
  const current = harness(catalog);
  const result = await current.repository.create(
    createToolResultKeyRetirementReceiptCommand({
      expectedCatalogGeneration: catalog.generation,
      expectedCatalogDigest: catalog.catalogDigest,
      keyId: 'result-key-a',
      mutationId: 'coverage-pressure-retirement-receipt',
    }),
  );

  assert.equal(result.status, 'created');
  assert.equal(result.receipt.bindingCount, COVERAGE_COUNT);
  assert.equal(result.receipt.overlayHeadCount, COVERAGE_COUNT);
  assert.equal(result.receipt.uncoveredBindingCount, 0);
  assert.equal(result.receipt.uncoveredOverlayHeadCount, 0);
  assert.deepEqual(current.coverageCalls, [
    { cursor: '', limit: PAGE_SIZE },
    {
      cursor: 'artifact-coverage-pressure-063',
      limit: PAGE_SIZE,
    },
    {
      cursor: 'artifact-coverage-pressure-127',
      limit: PAGE_SIZE,
    },
  ]);
  assert.equal(current.released(), 1);
});
