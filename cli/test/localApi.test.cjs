const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { LocalApi } = require('../dist/local/api');
const { createContext } = require('../dist/local/context');

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-local-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const context = createContext(
    { root },
    { PATH: process.env.PATH, QlPort: String(server.address().port) },
  );
  await fs.mkdir(context.paths.dir_config, { recursive: true });
  return context;
}

async function token(
  context,
  value = 'fixture-token',
  expiration = Date.now() / 1000 + 3600,
) {
  await fs.writeFile(
    context.paths.file_auth_token,
    JSON.stringify({ value, expiration }),
  );
}

test('local API preserves every legacy request shape and JSON special characters', async (t) => {
  const requests = [];
  const context = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : undefined,
    });
    res.end(JSON.stringify({ code: 200, data: null }));
  });
  await token(context);
  const api = new LocalApi(context);
  const name = '任务 "quoted" \\ newline\n';
  const command = 'task "owner/repo name.js" -- "a:b"';
  const cases = [
    ['crons', 'POST', { name, command, schedule: '0 1 * * *', sub_id: 4 }],
    ['crons', 'PUT', { name, command, schedule: '0 2 * * *', id: '7' }],
    ['crons', 'PUT', { command, id: '7' }],
    ['crons', 'DELETE', [7, 8]],
    [
      'crons/status',
      'PUT',
      {
        ids: [7],
        status: '1',
        pid: '12',
        log_path: 'a/1.log',
        last_execution_time: 123,
        last_running_time: 5,
        exit_code: 7,
        execution_id: 'legacy-system:123:fixture',
      },
    ],
    ['system/notify', 'PUT', { title: name, content: 'line1\nline2\\"' }],
    [
      `crons/detail?${new URLSearchParams({ log_path: 'a space/日志.log' })}`,
      'GET',
      undefined,
    ],
    ['system/auth/reset', 'PUT', { retries: 0 }],
    ['system/auth/reset', 'PUT', { twoFactorActivated: false }],
    ['system/auth/reset', 'PUT', { password: name }],
    ['system/auth/reset', 'PUT', { username: name }],
    ['dashboard/record', 'POST', { ref_id: 7, code: 7, elapsed: 5 }],
  ];
  for (const [endpoint, method, body] of cases)
    assert.deepEqual(await api.call(endpoint, method, body), {
      code: 200,
      data: null,
    });
  assert.deepEqual(
    requests,
    cases.map(([endpoint, method, body]) => ({
      url: `/open/${endpoint}`,
      method,
      body,
      authorization: 'Bearer fixture-token',
    })),
  );
});

test('local credentials reuse valid cache and regenerate missing, expired or malformed files', async (t) => {
  for (const state of ['valid', 'missing', 'expired', 'malformed']) {
    await t.test(state, async (t) => {
      const auth = [];
      const context = await fixture(t, (req, res) => {
        auth.push(req.headers.authorization);
        res.end(JSON.stringify({ code: 200 }));
      });
      const marker = path.join(context.root, 'generated');
      context.env.TOKEN_FILE = context.paths.file_auth_token;
      context.env.GENERATOR_MARKER = marker;
      await fs.mkdir(path.join(context.root, 'static/build'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(context.root, 'static/build/token.js'),
        'const fs=require("fs");fs.appendFileSync(process.env.GENERATOR_MARKER,"generated\\n");' +
          'fs.writeFileSync(process.env.TOKEN_FILE,JSON.stringify({value:"generated-token",expiration:Date.now()/1000+3600}));' +
          'console.log("generated-token")',
      );
      if (state === 'valid') await token(context);
      if (state === 'expired') await token(context, 'expired-token', 1);
      if (state === 'malformed')
        await fs.writeFile(context.paths.file_auth_token, 'invalid-json');
      const api = new LocalApi(context);
      await api.call('crons');
      await api.call('crons');
      assert.deepEqual(
        auth,
        Array(2).fill(
          `Bearer ${state === 'valid' ? 'fixture-token' : 'generated-token'}`,
        ),
      );
      if (state === 'valid')
        await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
      else assert.equal(await fs.readFile(marker, 'utf8'), 'generated\n');
    });
  }
});

test('local API rejects bad responses and redirects without replaying mutations', async (t) => {
  const seen = [];
  const context = await fixture(t, (req, res) => {
    seen.push(req.url);
    if (req.url === '/open/redirect') {
      res.writeHead(307, { location: '/open/redirect-target' });
      res.end();
    } else if (req.url === '/open/http-error') {
      res.writeHead(500);
      res.end('fixture-token');
    } else if (req.url === '/open/api-error') {
      res.end(JSON.stringify({ code: 403, message: 'fixture-token' }));
    } else res.end('not-json fixture-token');
  });
  await token(context);
  const api = new LocalApi(context);
  for (const endpoint of [
    'redirect',
    'http-error',
    'api-error',
    'invalid-json',
  ]) {
    await assert.rejects(
      api.call(endpoint, 'PUT', { value: 'secret-input' }),
      (error) => {
        assert.doesNotMatch(error.message, /fixture-token|secret-input/);
        return true;
      },
    );
  }
  assert.deepEqual(seen, [
    '/open/redirect',
    '/open/http-error',
    '/open/api-error',
    '/open/invalid-json',
  ]);
});

test(
  'cancelled local API requests do not replay mutations and final lifecycle still reports',
  { timeout: 5000 },
  async (t) => {
    const { cancellableOperation } = require('../dist/local/cancellation');
    const { loggedOperation } = require('../dist/local/commandLog');
    for (const partialBody of [false, true]) {
      const controller = new AbortController();
      const calls = [];
      const context = await fixture(t, async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        calls.push({ url: req.url, body: JSON.parse(body) });
        if (req.url === '/open/crons') {
          if (partialBody) {
            res.writeHead(200);
            res.write('{"code":');
          }
          controller.abort('SIGTERM');
          return;
        }
        res.end(JSON.stringify({ code: 200 }));
      });
      await token(context);
      context.env.QL_CLI_LIFECYCLE = 'extended';
      context.env.ID = '7';
      context.env.no_tee = 'true';
      await assert.rejects(
        loggedOperation(
          context,
          'raw',
          () => new LocalApi(context).call('crons', 'POST', { name: 'once' }),
          controller.signal,
        ),
        /do not retry a mutation|不要直接重试写入/,
      );
      assert.deepEqual(
        calls.map((call) => call.url),
        ['/open/crons/status', '/open/crons', '/open/crons/status'],
      );
      assert.equal(calls[2].body.exit_code, 143);
      assert.equal(calls[2].body.status, '1');
      await assert.rejects(
        cancellableOperation(controller.signal, () =>
          new LocalApi(context).call('crons', 'POST', {}),
        ),
      );
      assert.equal(calls.length, 3);
    }
  },
);

for (const language of ['zh', 'en', 'unsupported']) {
  test(`local API errors preserve language, status and no-replay behavior: ${language}`, async (t) => {
    const seen = [];
    const context = await fixture(t, (req, res) => {
      seen.push(req.url);
      if (req.url.endsWith('/http')) {
        res.statusCode = 503;
        res.end('private-server-body');
      } else
        res.end(JSON.stringify({ code: 403, message: 'private-server-body' }));
    });
    context.env.QL_LANG = language;
    const expected = (zh, en) => (language === 'en' ? en : zh);
    const check = (code, zh, en) => (error) => {
      assert.equal(error.exitCode, code);
      assert.match(error.message, expected(zh, en));
      assert.doesNotMatch(
        error.message,
        /fixture-token|private-server-body|private-input/,
      );
      return true;
    };
    await fs.mkdir(path.join(context.root, 'static/build'), {
      recursive: true,
    });
    await fs.writeFile(path.join(context.root, 'static/build/token.js'), '');
    await assert.rejects(
      new LocalApi(context).call('http'),
      check(3, /无法获取本机系统令牌/, /Cannot obtain a local system token/),
    );
    assert.deepEqual(seen, []);
    await token(context);
    const port = context.env.QlPort;
    context.env.QlPort = 'invalid';
    await assert.rejects(
      new LocalApi(context).call('http'),
      check(2, /端口无效/, /Invalid local panel port/),
    );
    assert.deepEqual(seen, []);
    context.env.QlPort = port;
    await assert.rejects(
      new LocalApi(context).call('http', 'PUT', { value: 'private-input' }),
      check(1, /不要直接重试写入/, /do not retry a mutation/),
    );
    await assert.rejects(
      new LocalApi(context).call('rejected', 'PUT', { value: 'private-input' }),
      check(
        1,
        /拒绝请求.*面板日志和权限/,
        /rejected request.*logs and permissions/,
      ),
    );
    assert.deepEqual(seen, ['/open/http', '/open/rejected']);
  });
}
