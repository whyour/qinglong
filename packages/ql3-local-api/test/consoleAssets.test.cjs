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
      assert.match(text, /attempts\/\$\{attempt\.id\}\/log/u);
      assert.match(text, /const LOG_READ_BYTES = 32 \* 1024/u);
      assert.match(text, /new TextDecoder\('utf-8'\)/u);
      assert.match(text, /日志已按保留策略清理/u);
      assert.match(text, /method: 'PUT'/u);
      assert.match(text, /x-qinglong-local-presence/u);
      assert.match(text, /x-qinglong-task-authoring-lease/u);
      assert.match(text, /local_presence_required/u);
      assert.match(text, /state\.pendingPresence/u);
      assert.match(text, /tasks\/\$\{task\.taskId\}\/authoring/u);
      assert.match(text, /\^ql3p_/u);
      assert.match(text, /\.\.\.snapshot\.task\.spec\.config/u);
      assert.match(text, /snapshot\.task\.labels/u);
      assert.match(text, /setAttribute\('aria-readonly', 'true'\)/u);
      assert.match(text, /qinglong\/cron@v1/u);
      assert.match(text, /triggers\/\$\{mutation\.triggerId\}/u);
      assert.match(text, /state\.view === 'triggers'/u);
      assert.match(text, /trigger_fence_rejected/u);
      assert.match(text, /state\.view === 'secrets'/u);
      assert.match(text, /secret-mutation/u);
      assert.match(text, /createSecretRef/u);
      assert.match(text, /kind: 'secret'/u);
      assert.match(text, /secret_query_unavailable/u);
      assert.equal(
        /localStorage.*plaintext|sessionStorage.*plaintext/u.test(text),
        false,
      );
    }
    if (requestPath === '/') {
      assert.match(text, /id="task-editor-dialog"/u);
      assert.match(text, /id="presence-dialog"/u);
      assert.match(text, /保存并生成本机证明/u);
      assert.match(text, /id="task-editor-title"/u);
      assert.match(text, /id="presence-copy"/u);
      assert.match(text, /id="trigger-editor-dialog"/u);
      assert.match(text, /data-view="triggers"/u);
      assert.match(text, /data-view="secrets"/u);
      assert.match(text, /id="secret-editor-dialog"/u);
      assert.match(text, /id="task-secret-bindings-input"/u);
      assert.match(text, /AES-256-GCM/u);
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
