const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  bootstrapLocalProfileStorage,
} = require('../dist/profile/localProfile');

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-profile-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

test('disabled local Profile does not inspect or create the database path', async () => {
  const records = [];
  const databasePath = path.join(
    os.tmpdir(),
    'ql3-local-profile-parent-does-not-exist',
    'database.sqlite',
  );
  const result = await bootstrapLocalProfileStorage({
    enabled: false,
    profile: 'edge',
    databasePath,
    audit: (record) => records.push(record),
  });
  assert.equal(result.status, 'disabled');
  assert.equal(await result.stop(), 'stopped');
  assert.equal(fs.existsSync(databasePath), false);
  assert.deepEqual(records, [{ profile: 'edge', state: 'disabled' }]);
});

test('enabled local Profile owns one ready repository and idempotent stop', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const records = [];
  const result = await bootstrapLocalProfileStorage({
    enabled: true,
    profile: 'edge',
    databasePath,
    audit: (record) => records.push(record),
  });
  assert.equal(result.status, 'storage_ready');
  assert.equal(result.profile, 'edge');
  assert.equal(result.evidence.journalMode, 'delete');
  assert.equal(await result.runs.findRunById('missing'), null);
  assert.deepEqual(await result.startupRecovery.inspectCandidates(), {
    candidates: [],
    truncated: false,
  });
  assert.deepEqual(await Promise.all([result.stop(), result.stop()]), [
    'stopped',
    'stopped',
  ]);
  assert.deepEqual(
    records.map(({ state }) => state),
    ['storage_ready', 'stopped'],
  );
});

test('unprepared storage fails closed without auto-migration', async (t) => {
  const databasePath = fixture(t);
  new (require('node:sqlite').DatabaseSync)(databasePath).close();
  const records = [];
  await assert.rejects(
    bootstrapLocalProfileStorage({
      enabled: true,
      profile: 'standalone',
      databasePath,
      audit: (record) => records.push(record),
    }),
    /not ready/,
  );
  assert.deepEqual(records, [{ profile: 'standalone', state: 'failed' }]);
});
