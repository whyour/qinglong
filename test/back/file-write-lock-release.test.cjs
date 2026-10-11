const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const load = require('../helpers/load-security-module.cjs');
const { writeFileWithLock, getUniqueLockPath } = load('back/shared/utils.ts', {
  '../config/util': { fileExist: async (p) => fs.existsSync(p) },
});
test('write failure releases the lock and preserves the original error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-lock-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'script');
  fs.writeFileSync(p, 'original');
  await assert.rejects(
    writeFileWithLock(p, 'bad', { encoding: 'invalid-encoding' }),
    (e) => e.code === 'ERR_INVALID_ARG_VALUE',
  );
  assert.equal(fs.existsSync(getUniqueLockPath(p)), false);
  await writeFileWithLock(p, 'retry');
  assert.equal(fs.readFileSync(p, 'utf8'), 'retry');
});
test('first write closes its file handle and keeps requested permissions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-lock-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'new');
  await writeFileWithLock(p, 'created', { mode: 0o600 });
  assert.equal(fs.readFileSync(p, 'utf8'), 'created');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});
