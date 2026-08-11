const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  LocalOwnerPepperCatalogFullError,
  LocalOwnerPepperGenerationConflictError,
  LocalOwnerPepperMutationConflictError,
} = require('@qinglong/runtime-core/local-owner-pepper');
const {
  openLocalSqliteBootstrapDatabase,
} = require('../dist/storage/bootstrap');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-pepper-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

function registration(index, overrides = {}) {
  return {
    mutationId: `018f4f58-7d5a-4d82-8f7d-5da12f05c0${String(index).padStart(2, '0')}`,
    pepperKeyId: `owner-key-${index}`,
    materialDigest: index.toString(16).padStart(64, '0'),
    backupDigest: (index + 16).toString(16).padStart(64, '0'),
    registeredAtMs: 100 + index,
    ...overrides,
  };
}

test('registers, activates and rotates with one append-only generation winner', async (t) => {
  const databasePath = fixture(t);
  const options = { databasePath, profile: 'edge' };
  await migrateLocalSqlitePath(options);
  const first = await openLocalSqliteBootstrapDatabase(options);
  const second = await openLocalSqliteBootstrapDatabase(options);
  t.after(() => Promise.all([first.close(), second.close()]));

  const key1 = registration(1);
  assert.equal((await first.ownerPepper.register(key1)).status, 'inserted');
  assert.equal((await second.ownerPepper.register(key1)).status, 'existing');
  const activation1 = {
    mutationId: '018f4f58-7d5a-4d82-8f7d-5da12f05d001',
    pepperKeyId: key1.pepperKeyId,
    expectedGeneration: 0,
    activatedAtMs: 200,
  };
  assert.equal(
    (await first.ownerPepper.activate(activation1)).activation.generation,
    1,
  );
  assert.equal(
    (await second.ownerPepper.activate(activation1)).status,
    'existing',
  );

  const key2 = registration(2);
  const key3 = registration(3);
  await first.ownerPepper.register(key2);
  await first.ownerPepper.register(key3);
  const contenders = [key2, key3].map((key, index) =>
    [first, second][index].ownerPepper.activate({
      mutationId: `018f4f58-7d5a-4d82-8f7d-5da12f05d00${index + 2}`,
      pepperKeyId: key.pepperKeyId,
      expectedGeneration: 1,
      expectedActivePepperKeyId: key1.pepperKeyId,
      activatedAtMs: 300 + index,
    }),
  );
  const settled = await Promise.allSettled(contenders);
  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = settled.find(({ status }) => status === 'rejected');
  assert.ok(rejection.reason instanceof LocalOwnerPepperGenerationConflictError);

  const active = await first.ownerPepper.resolveActive();
  assert.equal(active.generation, 2);
  assert.equal((await first.ownerPepper.resolveKey(key1.pepperKeyId)).state, 'retired');
  assert.equal(
    (await first.ownerPepper.resolveKey(active.activePepperKeyId)).state,
    'active',
  );
});

test('rejects semantic mutation drift and caps the catalog at eight keys', async (t) => {
  const databasePath = fixture(t);
  const options = { databasePath, profile: 'standalone' };
  await migrateLocalSqlitePath(options);
  const database = await openLocalSqliteBootstrapDatabase(options);
  t.after(() => database.close());

  const first = registration(1);
  await database.ownerPepper.register(first);
  await assert.rejects(
    database.ownerPepper.register({ ...first, backupDigest: 'f'.repeat(64) }),
    LocalOwnerPepperMutationConflictError,
  );
  for (let index = 2; index <= 8; index += 1) {
    await database.ownerPepper.register(registration(index));
  }
  await assert.rejects(
    database.ownerPepper.register(registration(9)),
    LocalOwnerPepperCatalogFullError,
  );
});
