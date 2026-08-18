require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { readDirs } = require('../../back/config/util');

const temporaryDirectories = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-file-tree-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('readDirs preserves the recursive tree contract and ignores blocked entries', async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, 'folder'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'z.js'), 'z');
  await fs.writeFile(path.join(root, 'folder', 'a.js'), 'alpha');
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.js'), 'hidden');
  await fs.symlink(path.join(root, 'folder'), path.join(root, 'linked-folder'));

  const result = await readDirs(root, root, ['node_modules'], (a, b) => {
    if (a.type === b.type) return a.title.localeCompare(b.title);
    return a.type === 'directory' ? -1 : 1;
  });

  assert.deepEqual(
    result.map(({ title, type, key, parent }) => ({
      title,
      type,
      key,
      parent,
    })),
    [
      { title: 'folder', type: 'directory', key: 'folder', parent: '' },
      { title: 'z.js', type: 'file', key: 'z.js', parent: '' },
    ],
  );
  assert.equal(result[0].children.length, 1);
  assert.equal(result[0].children[0].title, 'a.js');
  assert.equal(result[0].children[0].key, path.join('folder', 'a.js'));
  assert.equal(result[0].children[0].parent, 'folder');
  assert.equal(result[0].children[0].size, 5);
});
