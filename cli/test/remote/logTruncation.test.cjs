const { test } = require('node:test');
const assert = require('node:assert/strict');
const { task } = require('../../dist/remote/commands/task');
const { subscription } = require('../../dist/remote/commands/subscription');

test('task and subscription logs preserve server truncation as well as local tail limits', async (t) => {
  const previous = { url: process.env.QL_URL, token: process.env.QL_ACCESS_TOKEN };
  process.env.QL_URL = 'http://127.0.0.1';
  process.env.QL_ACCESS_TOKEN = 'fixture';
  t.after(() => {
    for (const [key, value] of [['QL_URL', previous.url], ['QL_ACCESS_TOKEN', previous.token]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let response;
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify(response), {
    headers: { 'content-type': 'application/json' },
  }));
  const run = async (tail) => [
    await task({ kind: 'logs', id: 1, tail }),
    await subscription({ name: 'subscription logs', positionals: ['1'], values: { tail: String(tail) } }),
  ];

  // A byte-limited backend response can contain fewer lines than --tail.
  response = { code: 200, data: 'partial long line\nlast line\n', offset: 262144, total: 524288, truncated: true };
  for (const result of await run(200)) {
    assert.equal(result.data, 'partial long line\nlast line');
    assert.equal(result.truncated, true);
  }

  // Older backends omit truncated; complete responses may explicitly set false.
  for (const metadata of [{}, { truncated: false }]) {
    response = { code: 200, data: 'one\r\ntwo\r\nthree\r\n', ...metadata };
    for (const result of await run(2)) {
      assert.equal(result.data, 'two\nthree');
      assert.equal(result.truncated, true);
    }
    for (const result of await run(3)) {
      assert.equal(result.data, 'one\ntwo\nthree');
      assert.equal(result.truncated, false);
    }
  }
});
