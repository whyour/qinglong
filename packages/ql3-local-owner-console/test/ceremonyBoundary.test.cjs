const assert = require('node:assert/strict');
const { test } = require('node:test');

test('keeps the two reviewed Owner ceremony modules internal to console', () => {
  const manifest = require('../package.json');
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.',
    './authenticated-command',
    './credential-administration-delivery',
    './identity-authentication',
    './pepper-custody',
    './pepper-custody/destructive',
    './secret-delivery',
  ]);
  assert.throws(
    () => require('@qinglong/local-owner-console/bootstrap'),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
  assert.equal(
    typeof require('../dist/bootstrap').createLocalOwnerBootstrapService,
    'function',
  );
  assert.equal(
    typeof require('../dist/credential-recovery')
      .createLocalOwnerCredentialRecoveryService,
    'function',
  );
});
