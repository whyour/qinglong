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
    'GRPC/client.key',
    'alias/client.key',
    'outside/new.txt',
    'dangling',
    'auth.json',
    'AUTH.JSON',
    'nested/auth.json',
    'nested/Auth.Json',
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

for (const kind of [
  'directory',
  'outside-link',
  'dangling-link',
  'swapped-directory',
]) {
  test(`concurrent path creation preserves containment checks: ${kind}`, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-file-race-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const root = path.join(tmp, 'logs');
    const directory = path.join(root, 'shared-script');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const exists = fs.existsSync;
    t.mock.method(fs, 'existsSync', (file) => {
      if (file === directory && !exists(directory)) {
        if (kind === 'outside-link') fs.symlinkSync(outside, directory);
        else if (kind === 'dangling-link')
          fs.symlinkSync(path.join(outside, 'missing'), directory);
        else fs.mkdirSync(directory);
        // Simulate an earlier existsSync result racing with another writer.
        return false;
      }
      return exists(file);
    });
    if (kind === 'swapped-directory') {
      const lstat = fs.lstatSync;
      t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const entry = lstat(file, ...args);
        if (file === directory) {
          fs.rmdirSync(directory);
          fs.symlinkSync(outside, directory);
        }
        return entry;
      });
    }
    assert.equal(
      resolveFileAccess(root, ['shared-script/task.log']),
      kind === 'directory' ? path.join(directory, 'task.log') : '',
    );
  });
}
