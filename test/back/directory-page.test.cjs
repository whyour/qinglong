const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  checkDirectoryVersions,
  readDirectoryPage,
} = require('../../back/shared/directoryPage');

test('directory cursors survive inserts and deletes and search reaches unloaded folders', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-file-page-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'dir'));
  await fs.mkdir(path.join(root, '.tmp'));
  await fs.writeFile(path.join(root, '.tmp', 'secret'), '');
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
  for (const name of ['a', 'c', 'e', 'dir/needle#&.js', 'dir/needle2.js'])
    await fs.writeFile(path.join(root, name), '1');
  const read = (
    after = '',
    search = '',
    dir = '',
    folders = false,
    newest = false,
  ) =>
    readDirectoryPage(root, ['.tmp'], dir, after, search, folders, newest, 2);
  const first = await read();
  assert.deepEqual(
    first.data.map((x) => x.key),
    ['dir', 'a'],
  );
  await fs.unlink(path.join(root, 'a'));
  await fs.writeFile(path.join(root, 'b'), '2');
  const second = await read(first.next);
  assert.deepEqual(
    second.data.map((x) => x.key),
    ['b', 'c'],
  );
  assert.deepEqual(
    (await read(second.next)).data.map((x) => x.key),
    ['e'],
  );
  assert.deepEqual(
    (await read('', '', '', false, true)).data.map((x) => x.key),
    ['dir', 'e'],
  );
  assert.deepEqual(
    (await read('', '', '', true)).data.map((x) => x.key),
    ['dir'],
  );
  assert.deepEqual(
    (await read('', 'needle')).data.map((x) => x.key),
    ['dir/needle#&.js', 'dir/needle2.js'],
  );
  assert.deepEqual((await read('', 'secret')).data, []);
  for (const dir of ['../', '.tmp', 'outside'])
    await assert.rejects(read('', '', dir), { status: 403 });
});

test('a sparse cross-directory search resumes after an empty batch', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-file-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 513; i++)
    await fs.writeFile(path.join(root, 'a' + i), '');
  await fs.mkdir(path.join(root, 'z'));
  await fs.writeFile(path.join(root, 'z', 'needle'), '');
  const page = (after) =>
    readDirectoryPage(root, [], '', after, 'needle', false, false);
  const first = await page('');
  assert.deepEqual(first.data, []);
  assert.ok(first.next);
  assert.deepEqual(
    (await page(first.next)).data.map((x) => x.key),
    ['z/needle'],
  );
});

test('a delayed terminal page detects changes on either side of its cursor, including a previously traversed sibling', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-moved-page-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['a', 'b']) await fs.mkdir(path.join(root, dir));
  for (const key of ['a/one.js', 'b/two.js'])
    await fs.writeFile(path.join(root, key), key);
  const first = await readDirectoryPage(
    root,
    [],
    '',
    '',
    '.js',
    false,
    false,
    1,
  );
  const last = await readDirectoryPage(
    root,
    [],
    '',
    first.next,
    '.js',
    false,
    false,
    2,
  );
  assert.equal(last.next, null);
  assert.deepEqual(
    last.data.map((r) => r.key),
    ['b/two.js'],
  );
  const versions = [...first.versions, ...last.versions];
  assert.equal(await checkDirectoryVersions(root, [], versions), true);
  await fs.rename(path.join(root, 'b/two.js'), path.join(root, 'a/first.js'));
  await fs.unlink(path.join(root, 'a/one.js'));
  await fs.writeFile(path.join(root, 'b/new.js'), 'new');
  assert.equal(await checkDirectoryVersions(root, [], versions), false);
  const fresh = await readDirectoryPage(root, [], '', '', '.js', false, false);
  assert.deepEqual(
    fresh.data.map((r) => r.key),
    ['a/first.js', 'b/new.js'],
  );
  assert.equal(await checkDirectoryVersions(root, [], fresh.versions), true);
});

test('deleting and replacing the open directory invalidates its pages and a missing path can be checked again', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-replaced-page-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'open');
  await fs.mkdir(dir);
  const list = () => readDirectoryPage(root, [], 'open', '', '', false, false);
  const before = await list();
  await fs.rename(dir, path.join(root, 'moved'));
  const missing = await list();
  assert.deepEqual(missing.data, []);
  assert.equal(await checkDirectoryVersions(root, [], before.versions), false);
  assert.equal(await checkDirectoryVersions(root, [], missing.versions), true);
  await fs.mkdir(dir);
  assert.equal(await checkDirectoryVersions(root, [], missing.versions), false);
  assert.equal(await checkDirectoryVersions(root, [], before.versions), false);
  await fs.symlink(os.tmpdir(), path.join(root, 'external'));
  assert.equal(
    await checkDirectoryVersions(
      root,
      [],
      [
        ['external', null],
        ['../escape', null],
      ],
    ),
    false,
  );
});
