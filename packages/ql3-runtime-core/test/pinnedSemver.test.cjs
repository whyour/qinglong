const assert = require('node:assert/strict');
const { test } = require('node:test');

const { semver } = require('../dist/versioning/pinnedSemver');

test('delegates exact SemVer behavior to the pinned production provider', () => {
  const provider = semver();
  assert.equal(provider, semver());
  assert.equal(provider.valid('1.2.3'), '1.2.3');
  assert.equal(provider.valid('v1.2.3'), '1.2.3');
  assert.equal(provider.validRange('^1.2.3'), '>=1.2.3 <2.0.0-0');
  assert.equal(provider.compare('1.2.3', '1.2.4'), -1);
  assert.equal(provider.satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(
    provider.satisfies('2.0.0-beta.1', '>=2.0.0-beta.0 <2.0.0', {
      includePrerelease: true,
    }),
    true,
  );
});
