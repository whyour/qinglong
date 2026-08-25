const assert = require('node:assert/strict');
const test = require('node:test');

const {
  activeApiCredentialPepperKey,
  createSingletonApiCredentialPepperKeyring,
  normalizeApiCredentialPepperKeyring,
  resolveApiCredentialPepperKey,
} = require('../dist/security/identity-credential/apiCredentialPepperKeyring.js');

const LEGACY = 'A'.repeat(43);
const NEXT = Buffer.alloc(32, 2).toString('base64url');

test('normalizes a bounded dual-generation keyring and resolves exact keys', () => {
  const keyring = normalizeApiCredentialPepperKeyring({
    schemaVersion: 1,
    activePepperKeyId: 'rotation-2026-08',
    keys: [
      { pepperKeyId: 'legacy-v1', pepper: LEGACY },
      { pepperKeyId: 'rotation-2026-08', pepper: NEXT },
    ],
  });

  assert.deepEqual(activeApiCredentialPepperKey(keyring), {
    pepperKeyId: 'rotation-2026-08',
    pepper: NEXT,
  });
  assert.deepEqual(resolveApiCredentialPepperKey(keyring, 'legacy-v1'), {
    pepperKeyId: 'legacy-v1',
    pepper: LEGACY,
  });
  assert.equal(resolveApiCredentialPepperKey(keyring, 'missing-v1'), null);
});

test('singleton compatibility is explicit and preserves its key id', () => {
  assert.deepEqual(
    createSingletonApiCredentialPepperKeyring(LEGACY, 'legacy-v1'),
    {
      schemaVersion: 1,
      activePepperKeyId: 'legacy-v1',
      keys: [{ pepperKeyId: 'legacy-v1', pepper: LEGACY }],
    },
  );
});

test('rejects widened, duplicate, missing-active, empty, and oversized keyrings', () => {
  const valid = {
    schemaVersion: 1,
    activePepperKeyId: 'legacy-v1',
    keys: [{ pepperKeyId: 'legacy-v1', pepper: LEGACY }],
  };
  for (const candidate of [
    { ...valid, extra: true },
    { ...valid, keys: [] },
    {
      ...valid,
      keys: [valid.keys[0], valid.keys[0]],
    },
    { ...valid, activePepperKeyId: 'missing-v1' },
    {
      ...valid,
      keys: [
        valid.keys[0],
        { pepperKeyId: 'next-v1', pepper: NEXT },
        {
          pepperKeyId: 'third-v1',
          pepper: Buffer.alloc(32, 3).toString('base64url'),
        },
      ],
    },
    {
      ...valid,
      keys: [{ ...valid.keys[0], extra: true }],
    },
  ]) {
    assert.throws(
      () => normalizeApiCredentialPepperKeyring(candidate),
      /pepper keyring is invalid/,
    );
  }
});
