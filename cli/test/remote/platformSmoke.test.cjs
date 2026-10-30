const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const entry = path.resolve(__dirname, '../../dist/npm/ql.js');

test('saved login works on the host filesystem', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-platform-smoke-'));
  const config = path.join(dir, 'cli.json');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/panel/open/auth/token') {
      assert.equal(url.searchParams.get('client_id'), 'smoke-id');
      assert.equal(url.searchParams.get('client_secret'), 'smoke-secret');
      res.end(JSON.stringify({
        code: 200,
        data: {
          token: 'smoke-token',
          expiration: Math.floor(Date.now() / 1000) + 3600,
        },
      }));
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer smoke-token');
    assert.equal(url.pathname, '/panel/open/crons');
    res.end(JSON.stringify({ code: 200, data: { data: [], total: 0 } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    QL_CLI_CONFIG: config,
    QL_CLIENT_ID: 'smoke-id',
    QL_CLIENT_SECRET: 'smoke-secret',
    QL_URL: '',
    QL_ACCESS_TOKEN: '',
  };
  const invoke = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
  });
  const url = `http://127.0.0.1:${server.address().port}/panel`;
  const login = await invoke(['login', '--url', url, '--json']);
  assert.equal(login.code, 0, login.err);
  assert.equal(JSON.parse(login.out).data.authenticated, true);
  assert.equal(fs.lstatSync(config).isFile(), true);
  const status = await invoke(['auth', 'status', '--json']);
  assert.equal(status.code, 0, status.err);
  assert.equal(JSON.parse(status.out).data.authenticated, true);
  const list = await invoke(['task', 'list', '--json']);
  assert.equal(list.code, 0, list.err);
  assert.equal(JSON.parse(list.out).data.total, 0);
});
