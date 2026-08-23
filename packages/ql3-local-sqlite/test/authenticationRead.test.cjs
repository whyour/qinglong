const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  openLocalSqliteAuthenticationReadDatabase,
} = require('../dist/security/authenticationRead.js');
const { migrateLocalSqlitePath } = require('../dist/migration/migration.js');

test('authentication projection opens the target read-only without journal or file drift', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-auth-read-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  fs.chmodSync(databasePath, 0o600);
  const bytes = fs.readFileSync(databasePath);
  const before = fs.statSync(databasePath, { bigint: true });
  const database = await openLocalSqliteAuthenticationReadDatabase({
    databasePath,
    profile: 'edge',
  });
  try {
    assert.equal(database.profile, 'edge');
    assert.equal(database.readiness.contractName, 'local-control-core');
    assert.equal(database.readiness.contractVersion, 51);
    assert.equal(await database.apiCredentials.resolve('absent'), null);
    assert.equal(await database.ownerPepper.resolveKey('absent'), null);
  } finally {
    await database.close();
  }
  const after = fs.statSync(databasePath, { bigint: true });
  assert.equal(fs.readFileSync(databasePath).equals(bytes), true);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.deepEqual(fs.readdirSync(root).sort(), ['qinglong3.sqlite']);
});
