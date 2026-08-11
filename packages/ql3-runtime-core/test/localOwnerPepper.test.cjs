const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidLocalOwnerPepperValueError,
  normalizeActivateLocalOwnerPepperKeyCommand,
  normalizeRegisterLocalOwnerPepperKeyCommand,
} = require('../dist/local-owner/localOwnerPepper');

const mutationId = '018f4f58-7d5a-4d82-8f7d-5da12f05c001';

test('normalizes exact register and activation CAS commands', () => {
  const register = normalizeRegisterLocalOwnerPepperKeyCommand({
    mutationId,
    pepperKeyId: 'owner-2026-01',
    materialDigest: 'a'.repeat(64),
    backupDigest: 'b'.repeat(64),
    registeredAtMs: 10,
  });
  const activate = normalizeActivateLocalOwnerPepperKeyCommand({
    mutationId,
    pepperKeyId: register.pepperKeyId,
    expectedGeneration: 0,
    activatedAtMs: 11,
  });
  assert.equal(Object.isFrozen(register), true);
  assert.equal(Object.isFrozen(activate), true);
});

test('accepts production millisecond timestamps beyond the 32-bit version range', () => {
  const registeredAtMs = 1_760_000_000_000;
  const activatedAtMs = registeredAtMs + 1;
  assert.equal(
    normalizeRegisterLocalOwnerPepperKeyCommand({
      mutationId,
      pepperKeyId: 'owner-2026-01',
      materialDigest: 'a'.repeat(64),
      backupDigest: 'b'.repeat(64),
      registeredAtMs,
    }).registeredAtMs,
    registeredAtMs,
  );
  assert.equal(
    normalizeActivateLocalOwnerPepperKeyCommand({
      mutationId,
      pepperKeyId: 'owner-2026-01',
      expectedGeneration: 0,
      activatedAtMs,
    }).activatedAtMs,
    activatedAtMs,
  );
});

test('rejects widened, malformed and unfenced pepper commands', () => {
  assert.throws(
    () =>
      normalizeRegisterLocalOwnerPepperKeyCommand({
        mutationId,
        pepperKeyId: 'owner-2026-01',
        materialDigest: 'a'.repeat(64),
        backupDigest: 'b'.repeat(64),
        registeredAtMs: 10,
        material: 'secret',
      }),
    InvalidLocalOwnerPepperValueError,
  );
  assert.throws(
    () =>
      normalizeActivateLocalOwnerPepperKeyCommand({
        mutationId: 'bad',
        pepperKeyId: 'owner-2026-01',
        expectedGeneration: -1,
        activatedAtMs: 11,
      }),
    InvalidLocalOwnerPepperValueError,
  );
});
