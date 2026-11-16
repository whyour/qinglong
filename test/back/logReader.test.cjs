const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_LOG_CHUNK_BYTES,
  MAX_LOG_CHUNK_BYTES,
  readLogChunk,
} = require('../../back/shared/logReader');

test('log reader defaults to a bounded tail and supports incremental reads', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-reader-'));
  const file = path.join(directory, 'task.log');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const initial = 'a'.repeat(DEFAULT_LOG_CHUNK_BYTES * 2);
  await fs.writeFile(file, initial);

  const tail = await readLogChunk(file);
  assert.equal(tail.content.length, DEFAULT_LOG_CHUNK_BYTES);
  assert.equal(tail.offset, DEFAULT_LOG_CHUNK_BYTES);
  assert.equal(tail.nextOffset, initial.length);
  assert.equal(tail.truncated, true);

  await fs.appendFile(file, 'next');
  const incremental = await readLogChunk(file, { offset: tail.nextOffset });
  assert.equal(incremental.content, 'next');
  assert.equal(incremental.nextOffset, initial.length + 4);
});

test('log reader enforces the maximum chunk size', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-reader-'));
  const file = path.join(directory, 'large.log');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(file, 'x'.repeat(MAX_LOG_CHUNK_BYTES + 1024));

  const chunk = await readLogChunk(file, { limit: Number.MAX_SAFE_INTEGER });
  assert.equal(Buffer.byteLength(chunk.content), MAX_LOG_CHUNK_BYTES);
});

test('log reader preserves UTF-8 characters across byte boundaries', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-reader-'));
  const file = path.join(directory, 'utf8.log');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(file, 'a'.repeat(5) + '中文日志');

  const first = await readLogChunk(file, { offset: 0, limit: 7 });
  const second = await readLogChunk(file, {
    offset: first.nextOffset,
    limit: 7,
  });
  const third = await readLogChunk(file, {
    offset: second.nextOffset,
    limit: 7,
  });

  assert.equal(first.content + second.content + third.content, 'aaaaa中文日志');
  assert.equal((first.content + second.content + third.content).includes('�'), false);
});

test('missing logs return an empty chunk', async () => {
  const chunk = await readLogChunk('/path/that/does/not/exist.log');
  assert.deepEqual(chunk, {
    content: '',
    offset: 0,
    nextOffset: 0,
    total: 0,
    truncated: false,
  });
});

test('following a file distinguishes append, same-inode rewrites, and replacement', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-follow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.log');
  const original = 'A\n' + '相同内容🚀\n'.repeat(80);
  await fs.writeFile(file, original);
  const first = await readLogChunk(file, { follow: true, offset: 0 });
  const resume = chunk => readLogChunk(file, { cursor: chunk.cursor, offset: chunk.nextOffset });
  assert.equal((await resume(first)).cursor, first.cursor);
  await fs.appendFile(file, '追加\n');
  const appended = await resume(first);
  assert.equal(appended.reset, false);
  assert.equal(appended.content, '追加\n');

  // Preserve the entire suffix at the old offset while changing an earlier line.
  const sameSize = 'B' + original.slice(1) + appended.content;
  await fs.writeFile(file, sameSize);
  const rewritten = await resume(appended);
  assert.equal(rewritten.reset, true);
  assert.equal(rewritten.content, sameSize);
  await fs.rename(file, path.join(dir, 'previous.log'));
  await fs.writeFile(file, sameSize + '下一轮\n');
  const replaced = await resume(rewritten);
  assert.equal(replaced.reset, true);
  assert.equal(replaced.offset, 0);
  await fs.truncate(file, 0);
  const empty = await resume(replaced);
  assert.equal(empty.reset, true);
  assert.equal(empty.nextOffset, 0);
  await fs.appendFile(file, '新的第一行\n');
  assert.equal((await resume(empty)).content, '新的第一行\n');
});
