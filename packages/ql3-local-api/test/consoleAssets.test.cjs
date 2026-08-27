const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { test } = require('node:test');

const {
  loadLocalConsoleAssets,
} = require('../dist/console/localConsoleAssets.js');
const {
  startLocalApiHttpSurface,
} = require('../dist/transport/httpSurface.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        headers: {
          connection: 'close',
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}

test('loads one bounded offline Console asset closure', () => {
  const assets = loadLocalConsoleAssets();
  assert.deepEqual([...assets.keys()], ['/', '/console.css', '/console.js']);
  let totalBytes = 0;
  for (const [requestPath, asset] of assets) {
    assert.match(asset.etag, /^"[0-9a-f]{64}"$/);
    assert.ok(asset.body.byteLength >= 100);
    assert.ok(asset.body.byteLength <= 96 * 1024);
    totalBytes += asset.body.byteLength;
    const text = asset.body.toString('utf8');
    assert.equal(/https?:\/\//u.test(text), false);
    if (requestPath === '/console.js') {
      assert.equal(
        /\b(?:localStorage|sessionStorage|innerHTML|eval)\b/u.test(text),
        false,
      );
      assert.match(text, /authorization: `Bearer \$\{state\.token\}`/u);
      assert.match(text, /credentials: 'omit'/u);
    }
  }
  assert.ok(totalBytes <= 192 * 1024);
});

test('serves the Console without authentication and preserves API admission', async (t) => {
  const calls = [];
  const port = await reservePort();
  const active = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: {
      async prepare(value) {
        calls.push(value.operation.operationId);
        return {
          statusCode: 401,
          body: { code: 'authentication_required' },
        };
      },
    },
    randomUuid: () => '00000000-0000-4000-8000-000000000001',
  });
  t.after(() => active.stopAndDrain());

  for (const [requestPath, contentType] of [
    ['/', 'text/html; charset=utf-8'],
    ['/console.css', 'text/css; charset=utf-8'],
    ['/console.js', 'text/javascript; charset=utf-8'],
  ]) {
    const response = await request(port, requestPath);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], contentType);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(
      response.headers['cross-origin-resource-policy'],
      'same-origin',
    );
    assert.match(
      response.headers['content-security-policy'],
      /default-src 'none'/u,
    );
    assert.match(response.headers.etag, /^"[0-9a-f]{64}"$/);
    assert.ok(response.body.byteLength >= 100);
  }
  assert.deepEqual(calls, []);

  const favicon = await request(port, '/favicon.ico');
  assert.equal(favicon.statusCode, 204);
  assert.equal(favicon.headers['cache-control'], 'no-store');
  assert.equal(favicon.body.byteLength, 0);
  assert.deepEqual(calls, []);

  const api = await request(port, '/api/v3/projects/default/tasks?limit=1');
  assert.equal(api.statusCode, 401);
  assert.deepEqual(JSON.parse(api.body.toString('utf8')), {
    code: 'authentication_required',
  });
  assert.deepEqual(calls, ['task.list']);
});

test('rejects request bodies and query aliases on Console assets', async (t) => {
  const port = await reservePort();
  const active = await startLocalApiHttpSurface({
    profile: 'standalone',
    host: '127.0.0.1',
    port,
    admission: {
      async prepare() {
        throw new Error('static assets must not reach admission');
      },
    },
  });
  t.after(() => active.stopAndDrain());

  const body = await request(port, '/', {
    headers: { 'content-length': '1' },
    body: 'x',
  });
  assert.equal(body.statusCode, 400);
  assert.deepEqual(JSON.parse(body.body.toString('utf8')), {
    code: 'invalid_request_body',
  });

  const alias = await request(port, '/console.js?cache=1');
  assert.equal(alias.statusCode, 404);
  assert.deepEqual(JSON.parse(alias.body.toString('utf8')), {
    code: 'route_not_found',
  });
});
