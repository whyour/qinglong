const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  bootstrapEdgeAdoptedStorage,
} = require('@qinglong/local-admin/adopted-profile/edge');
const {
  bootstrapStandaloneAdoptedStorage,
} = require('@qinglong/local-admin/adopted-profile/standalone');

for (const [profile, bootstrap] of [
  ['edge', bootstrapEdgeAdoptedStorage],
  ['standalone', bootstrapStandaloneAdoptedStorage],
]) {
  test(`adopted ${profile} subpath fixes the Profile while remaining default-off`, async () => {
    const storage = [];
    const adoption = [];
    const result = await bootstrap({
      enabled: false,
      sourcePath: 'invalid',
      targetPath: 'invalid',
      recoveryPath: 'invalid',
      manifestPath: 'invalid',
      activationPath: 'invalid',
      expectedActivationDigest: 'invalid',
      audit: (record) => storage.push(record),
      adoptionAudit: (record) => adoption.push(record),
    });
    assert.equal(result.status, 'disabled');
    assert.equal(result.profile, profile);
    assert.equal(storage[0].profile, profile);
    assert.equal(adoption[0].profile, profile);
    await result.stop();
  });
}
