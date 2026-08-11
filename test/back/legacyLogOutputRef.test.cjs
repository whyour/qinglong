require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLegacyLogOutputRef,
  LEGACY_LOG_OUTPUT_REF_PREFIX,
  MAX_LEGACY_LOG_PATH_BYTES,
  parseLegacyLogOutputRef,
} = require('../../back/runtime/compatibility/legacyLogOutputRef');

test('round-trips a bounded relative legacy log path', () => {
  const logPath = 'task-name/2026-07-18-12-00-00.log';
  const outputRef = createLegacyLogOutputRef(logPath);

  assert.match(outputRef, /^legacy-log-v1\.[A-Za-z0-9_-]+$/);
  assert.equal(parseLegacyLogOutputRef(outputRef), logPath);
});

test('normalizes producer paths but requires a canonical encoded reference', () => {
  const canonical = createLegacyLogOutputRef('task//nested/./run.log');
  assert.equal(parseLegacyLogOutputRef(canonical), 'task/nested/run.log');

  const nonCanonical =
    LEGACY_LOG_OUTPUT_REF_PREFIX +
    Buffer.from('task//run.log').toString('base64url');
  assert.equal(parseLegacyLogOutputRef(nonCanonical), null);
});

test('rejects absolute, traversing, Windows and NUL-containing paths', () => {
  for (const value of [
    '/var/log/secret.log',
    '../secret.log',
    'task/../../secret.log',
    'C:\\secret.log',
    'task\\secret.log',
    'task/' + String.fromCharCode(0) + 'secret.log',
  ]) {
    assert.throws(() => createLegacyLogOutputRef(value));
  }
});

test('rejects oversized, malformed and non-canonical references', () => {
  assert.throws(() =>
    createLegacyLogOutputRef('a'.repeat(MAX_LEGACY_LOG_PATH_BYTES + 1)),
  );
  assert.equal(parseLegacyLogOutputRef('legacy-log-v1.'), null);
  assert.equal(parseLegacyLogOutputRef('legacy-log-v1.***'), null);
  assert.equal(parseLegacyLogOutputRef('legacy-log-v2.dGFzay5sb2c'), null);
  assert.equal(
    parseLegacyLogOutputRef(LEGACY_LOG_OUTPUT_REF_PREFIX + 'Zh'),
    null,
  );
  assert.equal(
    parseLegacyLogOutputRef(LEGACY_LOG_OUTPUT_REF_PREFIX + 'a'.repeat(513)),
    null,
  );
});
