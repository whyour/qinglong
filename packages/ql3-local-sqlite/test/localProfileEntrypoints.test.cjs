const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  bootstrapEdgeStorage,
} = require('@qinglong/local-sqlite/profile/edge');
const {
  bootstrapStandaloneStorage,
} = require('@qinglong/local-sqlite/profile/standalone');

for (const [profile, bootstrap] of [
  ['edge', bootstrapEdgeStorage],
  ['standalone', bootstrapStandaloneStorage],
]) {
  test(`${profile} subpath fixes the Profile and leaves disabled storage untouched`, async () => {
    const records = [];
    const databasePath = path.join(
      os.tmpdir(),
      `ql3-${profile}-missing`,
      'db.sqlite',
    );
    const result = await bootstrap({
      enabled: false,
      databasePath,
      audit: (record) => records.push(record),
    });
    assert.equal(result.profile, profile);
    assert.equal(result.status, 'disabled');
    assert.equal(fs.existsSync(databasePath), false);
    assert.deepEqual(records, [{ profile, state: 'disabled' }]);
  });
}
