const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');
const { resolveFileAccess } = load(
  path.join(__dirname, '../../back/shared/fileAccess.ts'),
);

test('file access enforces directory boundaries, blacklist descendants and symlinks', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-file-security-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'config');
  fs.mkdirSync(path.join(root, 'grpc'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'config-other'));
  fs.writeFileSync(path.join(root, 'normal.txt'), 'normal');
  fs.writeFileSync(path.join(root, 'grpc', 'client.key'), 'test-only');
  fs.symlinkSync(path.join(tmp, 'config-other'), path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'grpc'), path.join(root, 'alias'));
  fs.symlinkSync(path.join(root, 'normal.txt'), path.join(root, 'safe-link'));
  fs.symlinkSync(path.join(tmp, 'missing'), path.join(root, 'dangling'));
  for (const input of [
    '../config-other/secret',
    '/etc/passwd',
    'grpc/client.key',
    'alias/client.key',
    'outside/new.txt',
    'dangling',
    'auth.json',
    'nested/auth.json',
    '',
  ]) {
    assert.equal(
      resolveFileAccess(root, [input], ['grpc', 'auth.json']),
      '',
      input,
    );
  }
  for (const input of ['normal.txt', 'safe-link', 'new-dir/new.txt']) {
    assert.equal(
      resolveFileAccess(root, [input], ['grpc']),
      path.join(root, input),
      input,
    );
  }
});
