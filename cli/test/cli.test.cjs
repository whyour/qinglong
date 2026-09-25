const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const entry = path.resolve(__dirname, '../dist/npm/ql.js');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-ts-cli-'));
  const file = path.join(dir, 'config.json');
  const requests = [];
  const state = { mode: 'ok', log: 'one\r\ntwo\r\nthree\r\n' };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    requests.push({
      url,
      method: req.method,
      body,
      authorization: req.headers.authorization,
    });
    if (state.mode === 'disconnect') {
      req.socket.destroy();
      return;
    }
    if (state.mode === 'redirect') {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
      return;
    }
    if (state.mode === 'html401') {
      res.writeHead(401);
      res.end('secret-body');
      return;
    }
    if (state.mode === 'invalid') {
      res.end('invalid-secret-body');
      return;
    }
    res.setHeader('content-type', 'application/json');
    const json = (data) => res.end(JSON.stringify(data));
    if (state.mode === 'denied') {
      res.writeHead(403);
      json({ code: 403, message: 'test-secret' });
      return;
    }
    if (state.mode === 'apiError') {
      json({ code: 400, message: 'test-secret' });
      return;
    }
    if (state.mode === 'badData') {
      json({ code: 200, data: null });
      return;
    }
    if (state.mode === 'expiredAuth') {
      json({ code: 200, data: { token: 'expired', expiration: 1 } });
      return;
    }
    if (url.pathname === '/panel/open/auth/token') {
      assert.equal(url.searchParams.get('client_id'), 'test-id');
      assert.equal(url.searchParams.get('client_secret'), 'test-secret');
      assert.equal(req.headers.authorization, undefined);
      json({
        code: 200,
        data: {
          token: 'test-token',
          expiration: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    } else {
      assert.equal(req.headers.authorization, 'Bearer test-token');
      if (url.pathname === '/panel/open/crons/12/log')
        json({ code: 200, data: state.log, logStatus: 'completed' });
      else if (url.pathname === '/panel/open/crons/12')
        json({ code: 200, data: { id: 12, name: 'example', status: 1 } });
      else if (url.pathname === '/panel/open/crons')
        json({
          code: 200,
          data: { data: [{ id: 12, name: 'example' }], total: 1 },
        });
      else if (
        ['/panel/open/crons/run', '/panel/open/crons/stop'].includes(
          url.pathname,
        )
      ) {
        assert.equal(req.method, 'PUT');
        assert.equal(body, '[12]');
        json({ code: 200 });
      } else {
        res.writeHead(404);
        json({ code: 404 });
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/panel`;
  const invoke = (args, env = {}, executable = entry) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, ...args], {
        env: {
          ...process.env,
          QL_DIR: '/nonexistent',
          QL_CLI_CONFIG: file,
          QL_CLIENT_ID: 'test-id',
          QL_CLIENT_SECRET: 'test-secret',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '',
        err = '';
      child.stdout.on('data', (data) => (out += data));
      child.stderr.on('data', (data) => (err += data));
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, out, err }));
    });
  const login = async (prefix = ['login']) => {
    const result = await invoke([...prefix, '--url', url, '--json']);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out), {
      code: 200,
      data: { authenticated: true, url },
    });
    assert.doesNotMatch(result.out + result.err, /test-secret|test-token/);
    return result;
  };
  return { dir, file, requests, state, url, invoke, login };
}

function failure(result, code) {
  assert.equal(result.code, code, result.err);
  assert.equal(result.out, '');
  assert.equal(JSON.parse(result.err).code, code);
  assert.doesNotMatch(result.err, /test-secret|test-token|secret-body/);
}

test('compiled entry: login aliases, private storage, status, refresh and local logout', async (t) => {
  const f = await fixture(t);
  failure(await f.invoke(['task', 'list', '--json']), 3);
  await f.login();
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const status = await f.invoke(['auth', 'status', '--json']);
  assert.equal(status.code, 0, status.err);
  assert.equal(JSON.parse(status.out).data.scopeChecked, 'crons');
  assert.doesNotMatch(status.out, /test-secret|test-token/);
  assert.equal(f.requests.at(-1).url.pathname, '/panel/open/crons');
  const config = JSON.parse(fs.readFileSync(f.file));
  config.expiration = 1;
  fs.writeFileSync(f.file, JSON.stringify(config));
  const get = await f.invoke(['task', 'get', '12', '--json']);
  assert.equal(get.code, 0, get.err);
  assert.equal(JSON.parse(get.out).data.id, 12);
  assert.equal(f.requests.at(-2).url.pathname, '/panel/open/auth/token');
  await f.login(['auth', 'login']);
  const count = f.requests.length;
  const logout = await f.invoke(['auth', 'logout', '--json']);
  assert.equal(logout.code, 0, logout.err);
  assert.equal(JSON.parse(logout.out).data.localOnly, true);
  assert.equal(f.requests.length, count);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal((await f.invoke(['auth', 'logout', '--json'])).code, 0);
});

test('list pagination, exact task operations and log tail preserve the 2.x API contract', async (t) => {
  const f = await fixture(t);
  await f.login();
  const list = await f.invoke([
    'task',
    'list',
    '--search',
    '任务 & a',
    '--page',
    '2',
    '--size',
    '10',
    '--json',
  ]);
  assert.equal(list.code, 0, list.err);
  assert.deepEqual(JSON.parse(list.out).data, {
    data: [{ id: 12, name: 'example' }],
    total: 1,
  });
  assert.equal(
    f.requests.at(-1).url.searchParams.get('searchValue'),
    '任务 & a',
  );
  assert.equal(f.requests.at(-1).url.searchParams.get('page'), '2');
  assert.equal(f.requests.at(-1).url.searchParams.get('size'), '10');
  const logs = await f.invoke(['task', 'logs', '12', '--tail', '2', '--json']);
  assert.deepEqual(JSON.parse(logs.out), {
    code: 200,
    data: 'two\nthree',
    logStatus: 'completed',
    truncated: true,
  });
  f.state.log = '';
  const empty = await f.invoke(['task', 'logs', '12', '--json']);
  assert.deepEqual(JSON.parse(empty.out), {
    code: 200,
    data: '',
    logStatus: 'completed',
    truncated: false,
  });
  for (const action of ['run', 'stop']) {
    const result = await f.invoke(['task', action, '12', '--json']);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out).data, {
      taskId: 12,
      action,
      accepted: true,
    });
    assert.equal(f.requests.at(-1).url.pathname, `/panel/open/crons/${action}`);
    assert.equal(f.requests.at(-1).body, '[12]');
  }
});

test('invalid input is rejected before authentication or HTTP requests', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['task', 'run', '12;echo'],
    ['task', 'get', '-1'],
    ['task', 'run', '9007199254740992'],
    ['task', 'list', '--size', '201'],
    ['task', 'logs', '12', '--tail', '0'],
    ['task', 'list', '--page'],
    ['task', 'list', '--page', '1', '--page', '2'],
    ['task', 'stop', '12', '--unknown'],
    ['task', 'run'],
    ['task', 'run', '12', '13'],
    ['unknown'],
    ['login'],
    ['login', '--url', 'http://example.com'],
    ['login', '--url', 'https://user:password@example.com'],
    ['login', '--url', 'https://example.com?secret=value'],
    ['login', '--url', 'file:///tmp/config'],
  ])
    failure(await f.invoke([...args, '--json']), 2);
  failure(
    await f.invoke(['login', '--url', f.url, '--json'], {
      QL_CLIENT_ID: '',
      QL_CLIENT_SECRET: '',
    }),
    2,
  );
  assert.equal(f.requests.length, 0);
});

test('authentication failures, proxy errors and uncertain mutations never replay requests or leak secrets', async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const [mode, code] of [
    ['denied', 3],
    ['html401', 3],
    ['apiError', 1],
    ['invalid', 1],
    ['disconnect', 1],
    ['redirect', 1],
  ]) {
    f.state.mode = mode;
    const count = f.requests.length;
    const result = await f.invoke(['task', 'run', '12', '--json']);
    failure(result, code);
    assert.equal(f.requests.length, count + 1, mode);
    if (['invalid', 'disconnect', 'redirect'].includes(mode))
      assert.match(result.err, /outcome is unknown|执行结果未知/);
  }
  const prior = fs.readFileSync(f.file, 'utf8');
  failure(await f.invoke(['login', '--url', f.url, '--json']), 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), prior);
});

test('malformed successful responses are rejected, including expired authentication', async (t) => {
  const f = await fixture(t);
  await f.login();
  f.state.mode = 'badData';
  for (const args of [
    ['task', 'list'],
    ['task', 'get', '12'],
    ['task', 'logs', '12'],
    ['login', '--url', f.url],
  ]) {
    failure(await f.invoke([...args, '--json']), 1);
  }
  f.state.mode = 'expiredAuth';
  failure(await f.invoke(['login', '--url', f.url, '--json']), 1);
});

test('config permissions, malformed content and symlinks fail closed', async (t) => {
  const f = await fixture(t);
  await f.login();
  fs.chmodSync(f.file, 0o644);
  failure(await f.invoke(['task', 'list', '--json']), 1);
  fs.chmodSync(f.file, 0o600);
  fs.writeFileSync(f.file, '{broken');
  failure(await f.invoke(['task', 'list', '--json']), 1);
  fs.writeFileSync(
    f.file,
    JSON.stringify({ url: f.url, clientId: 123, clientSecret: 'test-secret' }),
  );
  failure(await f.invoke(['task', 'list', '--json']), 1);
  const target = path.join(f.dir, 'target');
  fs.renameSync(f.file, target);
  fs.symlinkSync(target, f.file);
  failure(await f.invoke(['task', 'list', '--json']), 1);
  await f.login();
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(target)).clientId, 123);
});

test('standalone compiled artifact and symlink run without repo runtime dependencies', async (t) => {
  const f = await fixture(t);
  const dist = path.join(f.dir, 'standalone');
  fs.cpSync(path.dirname(entry), dist, { recursive: true });
  const link = path.join(f.dir, 'ql');
  fs.symlinkSync(path.join(dist, 'ql.js'), link);
  const help = await f.invoke(['--help', '--json'], {}, link);
  assert.equal(help.code, 0, help.err);
  assert.match(JSON.parse(help.out).data.help, /QingLong 2.x/);
  const login = await f.invoke(['login', '--url', f.url, '--json'], {}, link);
  assert.equal(login.code, 0, login.err);
  const list = await f.invoke(['task', 'list', '--json'], {}, link);
  assert.equal(list.code, 0, list.err);
  assert.equal(JSON.parse(list.out).data.total, 1);
});

for (const language of ['zh', 'en', 'unsupported']) {
  test(`resource response errors are localized through the compiled public CLI: ${language}`, async (t) => {
    const f = await fixture(t);
    await f.login();
    f.state.mode = 'badData';
    for (const [args, chinese, english] of [
      [['task', 'list'], /任务列表响应无效/, /Invalid task list response/],
      [['task', 'get', '12'], /任务响应无效/, /Invalid task response/],
      [['task', 'logs', '12'], /日志响应无效/, /Invalid log response/],
      [
        ['subscription', 'list'],
        /订阅列表响应无效/,
        /Invalid subscription list response/,
      ],
      [
        ['subscription', 'get', '12'],
        /订阅响应无效/,
        /Invalid subscription response/,
      ],
      [
        ['subscription', 'logs', '12'],
        /订阅日志响应无效/,
        /Invalid subscription log response/,
      ],
    ]) {
      const result = await f.invoke([...args, '--json'], { QL_LANG: language });
      failure(result, 1);
      assert.match(
        JSON.parse(result.err).message,
        language === 'en' ? english : chinese,
      );
    }
  });
}
