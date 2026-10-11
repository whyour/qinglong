const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { parse } = require('../helpers/commands.cjs');

test('public CLI excludes local maintenance while the admin entry retains compatibility names', () => {
  const help = parse(['--help']).help;
  assert.match(help, /subscription list/);
  assert.doesNotMatch(help, /resetpwd|local extra|rmlog/);
  for (const name of ['rmlog', 'resetpwd', 'extra'])
    assert.throws(() => parse([name, '1']), { exitCode: 2 });
  assert.equal(parse(['resetpwd', 'example'], 'local').name, 'local resetpwd');
  assert.doesNotMatch(
    parse(['--help'], 'local').help,
    /subscription list|auth login/,
  );
  assert.throws(
    () => parse(['auth', 'status', '--scope', 'all']),
    { exitCode: 2 },
  );
});

test('subscription management uses panel API, projects credentials out and never invokes local repo/raw', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-subscription-'));
  const records = [];
  const row = {
    id: 7,
    alias: 'sample',
    name: 'sample',
    status: 1,
    pull_option: { password: 'private-secret' },
    url: 'https://user:private-secret@example.com/repo.git',
    command: 'private-secret',
    sub_before: 'private-secret',
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    records.push({
      path: url.pathname,
      query: url.searchParams,
      body,
      method: req.method,
    });
    assert.equal(req.headers.authorization, 'Bearer sub-token');
    const data = url.pathname.endsWith('/log')
      ? 'one\ntwo\nthree\n'
      : url.pathname.endsWith('/7')
      ? row
      : [row];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = path.join(root, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}`,
      clientId: 'id',
      clientSecret: 'secret',
      token: 'sub-token',
      expiration: Date.now() / 1000 + 10000,
    }),
    { mode: 0o600 },
  );
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve(__dirname, '../../dist/npm/ql.js'), ...args, '--json'],
        {
          env: {
            ...process.env,
            QL_CLI_CONFIG: config,
            QL_DIR: '/not-a-panel',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        assert.equal(code, 0, err);
        assert.doesNotMatch(out + err, /private-secret/);
        resolve(JSON.parse(out));
      });
    });
  const status = await run(['auth', 'status', '--scope', 'subscriptions']);
  assert.equal(status.data.scopeChecked, 'subscriptions');
  const list = await run(['subscription', 'list', '--search', 'a & b']);
  assert.deepEqual(list.data, [
    { id: 7, name: 'sample', alias: 'sample', status: 1 },
  ]);
  assert.equal(records.at(-1).query.get('searchValue'), 'a & b');
  assert.equal((await run(['subscription', 'get', '7'])).data.id, 7);
  assert.deepEqual(await run(['subscription', 'logs', '7', '--tail', '2']), {
    code: 200,
    data: 'two\nthree',
    truncated: true,
  });
  for (const action of ['run', 'stop', 'enable', 'disable']) {
    const response = await run(['subscription', action, '7']);
    assert.deepEqual(response.data, {
      subscriptionId: 7,
      action,
      accepted: true,
    });
    assert.equal(records.at(-1).method, 'PUT');
    assert.equal(records.at(-1).body, '[7]');
    assert.equal(records.at(-1).path, `/open/subscriptions/${action}`);
  }
});

test('shared API errors identify subscription permission and uncertain subscription outcomes', async (t) => {
  const { request } = require('../../dist/remote/api/client');
  const http = require('node:http');
  let mode = 'denied',
    count = 0;
  const server = http.createServer((req, res) => {
    count++;
    if (mode === 'denied') {
      res.writeHead(403);
      res.end('forbidden');
    } else if (mode === 'api-denied') {
      res.end(JSON.stringify({ code: 403 }));
    } else {
      res.writeHead(503);
      res.end('unavailable');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    url: `http://127.0.0.1:${server.address().port}`,
    token: 'fixture',
    clientId: 'fixture',
    clientSecret: 'fixture',
    expiration: Date.now() / 1000 + 1000,
  };
  for (const failure of ['denied', 'api-denied']) {
    mode = failure;
    await assert.rejects(
      request(config, 'subscriptions'),
      (error) =>
        error.exitCode === 3 &&
        /subscriptions (permission|权限)/.test(error.message) &&
        !/crons/.test(error.message),
    );
  }
  mode = 'unavailable';
  await assert.rejects(
    request(config, 'subscriptions/run', { method: 'PUT', body: [1] }),
    /check subscription status before retrying|先检查订阅状态再考虑重试/,
  );
  assert.equal(count, 3);
});
