const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const load = require('../helpers/load-security-module.cjs');
const settle = () => new Promise((resolve) => setTimeout(resolve, 2100));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const io = { reads: 0, bytes: 0, afterRead: undefined };
  const { readLogChunk } = load('back/shared/logReader.ts', {
    'fs/promises': {
      ...fs,
      async open(...args) {
        const file = await fs.open(...args);
        const read = file.read.bind(file);
        file.read = async (...args) => {
          const result = await read(...args);
          io.reads++;
          io.bytes += result.bytesRead;
          await io.afterRead?.();
          return result;
        };
        return file;
      },
    },
  });
  const file = path.join(root, 'run.log');
  const follow = (chunk, target = file) =>
    readLogChunk(target, {
      offset: chunk.nextOffset,
      cursor: chunk.cursor,
      follow: true,
    });
  return { root, file, io, readLogChunk, follow };
}

test('verified EOF polls do not read retained content; appends still deliver every UTF-8 byte', async (t) => {
  const f = await fixture(t);
  const initial = '原始🚀\n'.repeat(500000);
  await fs.writeFile(f.file, initial);
  await settle();
  let chunk = await f.readLogChunk(f.file, { offset: 0, follow: true });
  let received = chunk.content;
  while (chunk.nextOffset < chunk.total) {
    chunk = await f.follow(chunk);
    received += chunk.content;
  }
  assert.equal(received, initial);
  const bytes = f.io.bytes;
  for (let i = 0; i < 50; i++) {
    const empty = await f.follow(chunk);
    assert.equal(empty.content, '');
    assert.equal(empty.reset, false);
    assert.equal(empty.cursor, chunk.cursor);
  }
  assert.equal(
    f.io.bytes,
    bytes,
    'idle viewers must not reread the 4 MiB window',
  );
  for (const appended of ['下一行🚀\n', 'another line\n', '结束']) {
    await fs.appendFile(f.file, appended);
    chunk = await f.follow(chunk);
    assert.equal(chunk.reset, false);
    assert.equal(chunk.content, appended);
  }
});

test('cached EOF detects same-size overwrite even when mtime is restored, truncation/regrowth and replacement', async (t) => {
  const f = await fixture(t);
  const original = 'A\n' + '共同后缀🚀\n'.repeat(20);
  await fs.writeFile(f.file, original);
  await settle();
  let chunk = await f.readLogChunk(f.file, { offset: 0, follow: true });
  await f.follow(chunk);
  const stat = await fs.stat(f.file);
  const replacement = 'B' + original.slice(1);
  await fs.writeFile(f.file, replacement);
  await fs.utimes(f.file, stat.atime, stat.mtime);
  chunk = await f.follow(chunk);
  assert.equal(chunk.reset, true);
  assert.equal(chunk.content, replacement);

  await fs.truncate(f.file);
  await fs.appendFile(f.file, original + 'more');
  chunk = await f.follow(chunk);
  assert.equal(chunk.reset, true);
  assert.equal(chunk.content, original + 'more');

  await fs.rename(f.file, path.join(f.root, 'previous.log'));
  await fs.writeFile(f.file, original + 'more');
  chunk = await f.follow(chunk);
  assert.equal(chunk.reset, true);
  assert.equal(chunk.offset, 0);
  assert.equal(chunk.content, original + 'more');

  await fs.truncate(f.file);
  chunk = await f.follow(chunk);
  assert.equal(chunk.reset, true);
  assert.equal(chunk.total, 0);
  assert.equal((await f.follow(chunk)).content, '');
  await fs.appendFile(f.file, '新文件\n');
  assert.equal((await f.follow(chunk)).content, '新文件\n');
});

test('EOF cache cannot validate another viewer offset, a forged cursor or a deleted log', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'abcdefghij');
  await settle();
  const first = await f.readLogChunk(f.file, {
    offset: 0,
    limit: 4,
    follow: true,
  });
  const last = await f.follow(first);
  const replay = await f.follow(first);
  assert.equal(replay.content, 'efghij');
  assert.equal(replay.reset, false);
  const forged = await f.follow({ ...last, cursor: last.cursor + 'bad' });
  assert.equal(forged.reset, true);
  assert.equal(forged.content, 'abcdefghij');
  await fs.unlink(f.file);
  const missing = await f.follow(last);
  assert.equal(missing.total, 0);
  assert.equal(missing.content, '');
  assert.equal(missing.cursor, undefined);
  await fs.writeFile(f.file, 'ABCDEFGHIJ');
  const recreated = await f.follow(last);
  assert.equal(recreated.reset, true);
  assert.equal(recreated.content, 'ABCDEFGHIJ');
});

test('cached EOF revalidates periodically without extending the deadline on hits', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'periodic verification\n');
  await settle();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const chunk = await f.readLogChunk(f.file, { offset: 0, follow: true });
  const reads = f.io.reads;
  now += 20000;
  await f.follow(chunk);
  assert.equal(f.io.reads, reads);
  now += 10001;
  await f.follow(chunk);
  assert.ok(f.io.reads > reads);
  const refreshedReads = f.io.reads;
  now -= 60000;
  await f.follow(chunk);
  assert.ok(
    f.io.reads > refreshedReads,
    'a backwards clock must invalidate the cache',
  );
});

test('EOF cache eviction falls back to content verification', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'first');
  const files = Array.from({ length: 256 }, (_, i) =>
    path.join(f.root, String(i)),
  );
  for (const file of files) await fs.writeFile(file, 'next');
  await settle();
  const first = await f.readLogChunk(f.file, { offset: 0, follow: true });
  for (const file of files) {
    await f.readLogChunk(file, { offset: 0, follow: true });
  }
  const reads = f.io.reads;
  assert.equal((await f.follow(first)).reset, false);
  assert.ok(f.io.reads > reads);
});

test('same-tick timestamps cannot hide a rewrite, including one racing with the EOF read', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-coarse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'coarse.log');
  await fs.writeFile(file, 'first version');
  const coarseStat = await fs.stat(file, { bigint: true });
  let now = Number(coarseStat.ctimeMs);
  t.mock.method(Date, 'now', () => now);
  let reads = 0;
  let afterRead;
  const { readLogChunk } = load('back/shared/logReader.ts', {
    'fs/promises': {
      ...fs,
      async open(...args) {
        const handle = await fs.open(...args);
        const read = handle.read.bind(handle);
        handle.stat = async () => coarseStat;
        handle.read = async (...args) => {
          reads++;
          const value = await read(...args);
          await afterRead?.();
          return value;
        };
        return handle;
      },
    },
  });
  const follow = (chunk) =>
    readLogChunk(file, {
      offset: chunk.nextOffset,
      cursor: chunk.cursor,
      follow: true,
    });
  let current = await readLogChunk(file, { offset: 0, follow: true });
  await fs.writeFile(file, 'other version');
  current = await follow(current);
  assert.equal(current.reset, true);
  assert.equal(current.content, 'other version');
  afterRead = async () => {
    afterRead = undefined;
    await fs.writeFile(file, 'third version');
  };
  await follow(current);
  current = await follow(current);
  assert.equal(current.reset, true);
  assert.equal(current.content, 'third version');
  now += 2100;
  current = await follow(current);
  const verifiedReads = reads;
  await follow(current);
  assert.equal(
    reads,
    verifiedReads,
    'an old timestamp becomes cacheable only after content is verified again',
  );
});

test('a rewrite racing with a read cannot cache an unverified EOF; incomplete UTF-8 is retried', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'old contents\n');
  f.io.afterRead = async () => {
    f.io.afterRead = undefined;
    await fs.writeFile(f.file, 'new contents\n');
  };
  let chunk = await f.readLogChunk(f.file, { offset: 0, follow: true });
  chunk = await f.follow(chunk);
  assert.equal(chunk.reset, true);
  assert.equal(chunk.content, 'new contents\n');

  const emoji = Buffer.from('🚀');
  await fs.writeFile(
    f.file,
    Buffer.concat([Buffer.from('prefix'), emoji.subarray(0, 2)]),
  );
  chunk = await f.readLogChunk(f.file, { offset: 0, follow: true });
  assert.equal(chunk.content, 'prefix');
  assert.equal(chunk.nextOffset, 6);
  assert.equal((await f.follow(chunk)).content, '');
  await fs.appendFile(f.file, emoji.subarray(2));
  chunk = await f.follow(chunk);
  assert.equal(chunk.content, '🚀');
  assert.equal(chunk.reset, false);
});
