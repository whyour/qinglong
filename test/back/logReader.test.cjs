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
