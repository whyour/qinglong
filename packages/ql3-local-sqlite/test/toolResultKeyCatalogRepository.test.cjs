const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ToolResultKeyCatalogConflictError,
  ToolResultKeyCatalogUnavailableError,
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRotationCommand,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  LocalSqliteToolResultKeyCatalogRepository,
} = require('@qinglong/local-sqlite/tool-result-key-catalog');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const { LocalSqliteOperationAuthority } = require('../dist/authority/operationAuthority');

async function harness() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    repository: new LocalSqliteToolResultKeyCatalogRepository(authority),
    close: () => authority.close(),
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

test('appends, exactly replays and reads the latest SQLite key generation', async () => {
  const current = await harness();
  try {
    assert.equal(await current.repository.findCurrent(), null);
    const bootstrap = bootstrapCommand();
    const first = await current.repository.append(bootstrap);
    assert.equal(first.status, 'created');
    assert.equal(first.catalog.generation, 1);
    assert.deepEqual(await current.repository.append(bootstrap), {
      status: 'existing',
      catalog: first.catalog,
    });

    const rotation = createToolResultKeyRotationCommand(first.catalog, {
      keyId: 'tool-result-key-002',
      materialProof: toolResultKeyMaterialProof(
        'tool-result-key-002',
        Buffer.alloc(32, 2),
      ),
      mutationId: 'tool-result-key-rotate-002',
    });
    const second = await current.repository.append(rotation);
    assert.equal(second.status, 'created');
    assert.equal(second.catalog.generation, 2);
    assert.deepEqual(await current.repository.findCurrent(), second.catalog);
    assert.equal(
      current.client
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "ToolResultKeyCatalogGenerations"`,
        )
        .get().count,
      2,
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
  } finally {
    await current.close();
  }
});

test('fails closed when the durable SQLite catalog projection drifts', async () => {
  const current = await harness();
  try {
    await current.repository.append(bootstrapCommand());
    current.client
      .prepare(
        `UPDATE "ToolResultKeyCatalogGenerations"
         SET command_digest = ?
         WHERE generation = 1`,
      )
      .run('c'.repeat(64));
    await assert.rejects(
      current.repository.findCurrent(),
      ToolResultKeyCatalogUnavailableError,
    );
  } finally {
    await current.close();
  }
});

test('publishes SQLite catalog mutation only through its explicit subpath', () => {
  const root = require('@qinglong/local-sqlite');
  const runtime = require('@qinglong/local-sqlite/runtime');
  const authority = require('@qinglong/local-sqlite/tool-result-key-catalog');
  assert.equal(root.LocalSqliteToolResultKeyCatalogRepository, undefined);
  assert.equal(runtime.LocalSqliteToolResultKeyCatalogRepository, undefined);
  assert.equal(
    typeof authority.LocalSqliteToolResultKeyCatalogRepository,
    'function',
  );
});
