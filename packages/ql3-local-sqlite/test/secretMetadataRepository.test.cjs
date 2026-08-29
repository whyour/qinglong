const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const { migrateLocalSqlitePath } = require('../dist/migration/migration.js');
const {
  openLocalSqliteRuntimeDatabase,
} = require('../dist/runtime/runtimeDatabase.js');

function insertSecret(database, name, version, createdAtMs) {
  database
    .prepare(
      `INSERT INTO "QingLong3LocalSecretEnvelopes"
         ("project_id", "secret_name", "version", "mutation_id", "key_id",
          "algorithm", "nonce", "ciphertext", "auth_tag", "created_at_ms")
       VALUES ('default', ?, ?, ?, 'active-key', 'aes-256-gcm', ?, ?, ?, ?)`,
    )
    .run(
      name,
      version,
      `00000000-0000-4000-8000-${String(createdAtMs).padStart(12, '0')}`,
      Buffer.alloc(12, version),
      Buffer.from(`cipher-${name}-${version}`),
      Buffer.alloc(16, version),
      createdAtMs,
    );
}

test('lists only current Secret metadata with a stable bounded cursor', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-secret-meta-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    directory,
    profile: 'edge',
    databasePath: path.join(directory, 'qinglong3.sqlite'),
  };
  await migrateLocalSqlitePath(options);
  const database = new DatabaseSync(options.databasePath);
  insertSecret(database, 'alpha', 1, 101);
  insertSecret(database, 'alpha', 2, 102);
  insertSecret(database, 'beta', 1, 103);
  insertSecret(database, 'gamma', 1, 104);
  database.close();

  const runtime = await openLocalSqliteRuntimeDatabase(options);
  const first = await runtime.localSecretMetadata.listLocalSecretMetadata({
    projectId: 'default',
    limit: 2,
  });
  assert.deepEqual(first, {
    secrets: [
      {
        projectId: 'default',
        name: 'alpha',
        currentVersion: 2,
        createdAtMs: 102,
      },
      {
        projectId: 'default',
        name: 'beta',
        currentVersion: 1,
        createdAtMs: 103,
      },
    ],
    truncated: true,
    next: { name: 'beta' },
  });
  assert.equal(JSON.stringify(first).includes('cipher'), false);
  assert.equal(JSON.stringify(first).includes('key'), false);
  assert.deepEqual(
    await runtime.localSecretMetadata.listLocalSecretMetadata({
      projectId: 'default',
      limit: 2,
      after: first.next,
    }),
    {
      secrets: [
        {
          projectId: 'default',
          name: 'gamma',
          currentVersion: 1,
          createdAtMs: 104,
        },
      ],
      truncated: false,
    },
  );

  await runtime.close();
  await assert.rejects(
    runtime.localSecretMetadata.listLocalSecretMetadata({
      projectId: 'default',
      limit: 1,
    }),
    { name: 'LocalSecretMetadataUnavailableError' },
  );
});

test('rejects widened and over-budget metadata queries before storage', async () => {
  const source = Object.create(
    require('../dist/security/secretMetadataRepository.js')
      .LocalSqliteSecretMetadataRepository.prototype,
  );
  assert.throws(
    () =>
      source.listLocalSecretMetadata({
        projectId: 'default',
        limit: 65,
      }),
    /options are invalid/u,
  );
});
