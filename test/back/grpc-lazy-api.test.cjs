const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiService } = require('../../back/protos/api');
const { lazyApiHandlers } = require('../../back/schedule/lazyApiHandlers');
test('registering script APIs loads no service graph; every unary method forwards calls and errors on demand', async (t) => {
  const apiPath = require.resolve('../../back/schedule/api');
  assert.equal(require.cache[apiPath], undefined);
  const handlers = lazyApiHandlers();
  assert.deepEqual(Object.keys(handlers), Object.keys(ApiService));
  assert.equal(require.cache[apiPath], undefined);
  t.after(() => delete require.cache[apiPath]);
  const calls = [];
  const exports = Object.fromEntries(
    Object.keys(ApiService).map((name) => [
      name,
      async (call, callback) => {
        calls.push(name);
        callback(null, { code: 200, data: call.request });
      },
    ]),
  );
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports,
  };
  await Promise.all(
    Object.keys(ApiService).map(
      (name) =>
        new Promise((resolve, reject) => {
          const request = { test: name };
          handlers[name]({ request }, (err, value) => {
            try {
              assert.equal(err, null);
              assert.equal(value.data, request);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        }),
    ),
  );
  assert.equal(calls.length, Object.keys(ApiService).length);
  exports.getCrons = async () => {
    throw Error('load/call failed');
  };
  await new Promise((resolve) =>
    handlers.getCrons({ request: {} }, (error) => {
      assert.match(error.message, /load\/call failed/);
      resolve();
    }),
  );
});
