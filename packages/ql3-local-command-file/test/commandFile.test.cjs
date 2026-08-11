const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
  readPrivateLocalJsonFile,
} = require('../dist');

function fixture(t, value = { schemaVersion: 1, operation: 'test' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-command-file-'));
  const filePath = path.join(root, 'command.json');
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filePath };
}

test('reads one bounded private JSON intent', (t) => {
  const value = { schemaVersion: 1, operation: 'test', mutationId: 'stable' };
  const { filePath } = fixture(t, value);
  assert.deepEqual(readPrivateLocalCommandFile(filePath), value);
});

test('rejects relative, broad, symlinked, oversized and malformed files', (t) => {
  assert.throws(
    () => readPrivateLocalCommandFile('command.json'),
    PrivateLocalCommandFileError,
  );
  const broad = fixture(t);
  fs.chmodSync(broad.filePath, 0o644);
  assert.throws(
    () => readPrivateLocalCommandFile(broad.filePath),
    PrivateLocalCommandFileError,
  );
  const linked = fixture(t);
  const linkPath = path.join(linked.root, 'link.json');
  fs.symlinkSync(linked.filePath, linkPath);
  assert.throws(
    () => readPrivateLocalCommandFile(linkPath),
    PrivateLocalCommandFileError,
  );
  const oversized = fixture(t);
  fs.writeFileSync(oversized.filePath, 'x'.repeat(16 * 1024 + 1), {
    mode: 0o600,
  });
  assert.throws(
    () => readPrivateLocalCommandFile(oversized.filePath),
    PrivateLocalCommandFileError,
  );
  const malformed = fixture(t);
  fs.writeFileSync(malformed.filePath, '{', { mode: 0o600 });
  assert.throws(
    () => readPrivateLocalCommandFile(malformed.filePath),
    PrivateLocalCommandFileError,
  );
  const invalidUtf8 = fixture(t);
  fs.writeFileSync(
    invalidUtf8.filePath,
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    { mode: 0o600 },
  );
  assert.throws(
    () => readPrivateLocalCommandFile(invalidUtf8.filePath),
    PrivateLocalCommandFileError,
  );
});

test('reuses the private descriptor protocol for explicitly bounded JSON', (t) => {
  const value = { payload: 'x'.repeat(32 * 1024) };
  const { filePath } = fixture(t, value);
  assert.deepEqual(
    readPrivateLocalJsonFile(filePath, { maxBytes: 64 * 1024 }),
    value,
  );
  assert.throws(
    () => readPrivateLocalCommandFile(filePath),
    PrivateLocalCommandFileError,
  );
  for (const options of [
    {},
    { maxBytes: 0 },
    { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES + 1 },
    { maxBytes: 64 * 1024, widened: true },
  ]) {
    assert.throws(
      () => readPrivateLocalJsonFile(filePath, options),
      PrivateLocalCommandFileError,
    );
  }
});
