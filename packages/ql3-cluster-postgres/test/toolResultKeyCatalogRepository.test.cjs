const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ToolResultKeyCatalogConflictError,
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRetirementCommand,
  createToolResultKeyRotationCommand,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  createToolResultKeyRetirementReceipt,
} = require('@qinglong/runtime-core/tool-result-rekey');
const {
  PostgresToolResultKeyCatalogReader,
} = require('@qinglong/cluster-postgres/runtime');
const {
  PostgresToolResultKeyCatalogRepository,
} = require('@qinglong/cluster-postgres/tool-result-key-catalog');

function jsonb(value) {
  if (Array.isArray(value)) return value.map(jsonb);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, jsonb(value[key])]),
  );
}

function row(catalog, commandDigest) {
  return {
    generation: String(catalog.generation),
    previousCatalogDigest: catalog.previousCatalogDigest,
    activeKeyId: catalog.activeKeyId,
    mutationKind: catalog.mutationKind,
    mutationId: catalog.mutationId,
    catalogDigest: catalog.catalogDigest,
    commandDigest,
    committedAtMs: String(catalog.committedAtMs),
    catalogJson: jsonb(catalog),
  };
}

function harness() {
  const calls = [];
  const history = [];
  const receipts = [];
  let released = 0;
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (
        text.startsWith('BEGIN') ||
        text === 'COMMIT' ||
        text === 'ROLLBACK' ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return { rows: [] };
      }
      if (text.includes('AND (mutation_id =')) {
        const found = history.filter(
          ({ catalog }) =>
            catalog.mutationId === values[1] ||
            catalog.generation === values[2] ||
            catalog.catalogDigest === values[3],
        );
        return {
          rows: found.map(({ catalog, commandDigest }) =>
            row(catalog, commandDigest),
          ),
        };
      }
      if (text.includes('tool_result_key_retirement_receipts')) {
        const receipt = receipts.find(
          (candidate) => candidate.receiptDigest === values[0],
        );
        return { rows: receipt ? [{ receiptJson: receipt }] : [] };
      }
      if (text.includes('FROM "ql3"."tool_result_key_catalog_generations"')) {
        return {
          rows: history
            .slice()
            .reverse()
            .slice(0, 2)
            .map(({ catalog, commandDigest }) => row(catalog, commandDigest)),
        };
      }
      if (text.includes('clock_timestamp()')) {
        return { rows: [{ now: String(1_000 + history.length) }] };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3"."tool_result_key_catalog_generations"',
        )
      ) {
        history.push({
          catalog: JSON.parse(values[10]),
          commandDigest: values[8],
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    async query(text, values) {
      return client.query(text, values);
    },
    async connect() {
      return client;
    },
  };
  return {
    calls,
    history,
    receipts,
    pool,
    repository: new PostgresToolResultKeyCatalogRepository(pool),
    reader: new PostgresToolResultKeyCatalogReader(pool),
    released: () => released,
  };
}

function bootstrapCommand() {
  return createToolResultKeyCatalogBootstrapCommand({
    keyId: 'tool-result-key-001',
    materialProof: toolResultKeyMaterialProof(
      'tool-result-key-001',
      Buffer.alloc(32, 1),
    ),
    mutationId: 'tool-result-key-bootstrap-001',
  });
}

test('serializes PostgreSQL key generations behind the catalog lock', async () => {
  const current = harness();
  assert.equal(await current.reader.findCurrent(), null);
  const bootstrap = bootstrapCommand();
  const first = await current.repository.append(bootstrap);
  assert.equal(first.status, 'created');
  assert.deepEqual(await current.repository.append(bootstrap), {
    status: 'existing',
    catalog: first.catalog,
  });

  const second = await current.repository.append(
    createToolResultKeyRotationCommand(first.catalog, {
      keyId: 'tool-result-key-002',
      materialProof: toolResultKeyMaterialProof(
        'tool-result-key-002',
        Buffer.alloc(32, 2),
      ),
      mutationId: 'tool-result-key-rotate-002',
    }),
  );
  assert.equal(second.catalog.generation, 2);
  assert.deepEqual(await current.reader.findCurrent(), second.catalog);
  assert.equal(current.history.length, 2);
  assert.equal(current.released(), 3);

  await assert.rejects(
    current.repository.append(
      createToolResultKeyRetirementCommand(second.catalog, {
        keyId: 'tool-result-key-001',
        retirementReceiptDigest: 'f'.repeat(64),
        mutationId: 'tool-result-key-retire-forged-001',
      }),
    ),
    ToolResultKeyCatalogConflictError,
  );
  const retiring = second.catalog.keys.find(
    (entry) => entry.keyId === 'tool-result-key-001',
  );
  const receipt = createToolResultKeyRetirementReceipt({
    catalogGeneration: second.catalog.generation,
    catalogDigest: second.catalog.catalogDigest,
    keyId: retiring.keyId,
    materialProof: retiring.materialProof,
    mutationId: 'tool-result-key-retirement-receipt-001',
    bindingCount: 0,
    overlayHeadCount: 0,
    coverageDigest: 'c'.repeat(64),
    createdAtMs: 1_500,
  });
  current.receipts.push(receipt);
  const retired = await current.repository.append(
    createToolResultKeyRetirementCommand(second.catalog, {
      keyId: 'tool-result-key-001',
      retirementReceiptDigest: receipt.receiptDigest,
      mutationId: 'tool-result-key-retire-001',
    }),
  );
  assert.equal(
    retired.catalog.keys.find(
      (entry) => entry.keyId === 'tool-result-key-001',
    ).state,
    'retired',
  );

  const transactionCalls = current.calls
    .map(({ text }) => text)
    .filter(
      (text) =>
        text.startsWith('BEGIN') ||
        text.includes('pg_advisory_xact_lock') ||
        text.startsWith(
          'INSERT INTO "ql3"."tool_result_key_catalog_generations"',
        ) ||
        text === 'COMMIT',
    );
  assert.equal(
    transactionCalls.indexOf('SELECT pg_advisory_xact_lock(190397473, 3)') <
      transactionCalls.findIndex((text) =>
        text.startsWith(
          'INSERT INTO "ql3"."tool_result_key_catalog_generations"',
        ),
      ),
    true,
  );

  await assert.rejects(
    current.repository.append(
      createToolResultKeyRotationCommand(first.catalog, {
        keyId: 'tool-result-key-stale',
        materialProof: toolResultKeyMaterialProof(
          'tool-result-key-stale',
          Buffer.alloc(32, 3),
        ),
        mutationId: 'tool-result-key-stale-003',
      }),
    ),
    ToolResultKeyCatalogConflictError,
  );
});
