const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidApiCredentialTokenValueError,
  apiCredentialSecretDigest,
  assertApiCredentialPepper,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

test('derives one domain-separated digest and formats the canonical token', () => {
  const pepper = Buffer.alloc(32, 1).toString('base64url');
  const secret = Buffer.alloc(32, 2).toString('base64url');
  assert.doesNotThrow(() => assertApiCredentialPepper(pepper));
  assert.equal(
    apiCredentialSecretDigest(pepper, 'app_primary', secret),
    'e15b6ff4b2ab5037c149974e6bd788eca4777e4d698f649373d39244555d4991',
  );
  assert.equal(
    formatApiCredentialToken('app_primary', secret),
    `ql3c_app_primary_${secret}`,
  );
});

test('rejects weak, non-canonical and widened token material', () => {
  const canonical = Buffer.alloc(32, 1).toString('base64url');
  for (const action of [
    () => assertApiCredentialPepper('weak'),
    () => apiCredentialSecretDigest(canonical, '../escape', canonical),
    () => apiCredentialSecretDigest(canonical, 'valid', `${canonical}=`),
    () => formatApiCredentialToken('valid', 'weak'),
  ]) {
    assert.throws(action, InvalidApiCredentialTokenValueError);
  }
});
