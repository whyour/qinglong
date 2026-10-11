const assert = require('node:assert/strict');
const test = require('node:test');

const protectedPathCase = require(
  '../../back/middlewares/protectedPathCase',
).default;

function runMiddleware(path) {
  let status;
  let body;
  let nextCalled = false;
  const response = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  protectedPathCase({ path }, response, () => {
    nextCalled = true;
  });

  return { status, body, nextCalled };
}

test('rejects case variations under protected API namespaces', () => {
  for (const path of [
    '/Api/configs/detail',
    '/api/Configs/detail',
    '/OPEN/scripts/detail',
    '/open/scripts/Detail',
  ]) {
    assert.deepEqual(runMiddleware(path), {
      status: 400,
      body: { code: 400, message: 'Invalid path format' },
      nextCalled: false,
    });
  }
});

test('allows normalized protected paths and unrelated paths', () => {
  for (const path of [
    '/api/configs/detail',
    '/open/scripts/detail',
    '/OpenApi/status',
    '/assets/AppBundle.js',
  ]) {
    assert.deepEqual(runMiddleware(path), {
      status: undefined,
      body: undefined,
      nextCalled: true,
    });
  }
});
