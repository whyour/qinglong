const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { openOperations } = require('../../dist/remote/api/openOperations');
const entry = path.resolve(__dirname, '../../dist/npm/ql.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-openapi-'));
  const requests = [];
  let reply;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    requests.push(record);
    if (reply) return reply(req, res);
    if (/\/(download|data\/export|command-run)$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="fixture.json"' });
      res.end('{"fixture":true}');
    } else if (req.url === '/panel/open/system/log') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('log content');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: { id: 7, name: 'fixture', client_secret: 'SECRET-MARKER', tokens: [{ value: 'TOKEN-MARKER' }] } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/panel`;
  const run = (args, stdin = '', extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, '--json'], {
      env: { PATH: process.env.PATH, QL_URL: url, QL_ACCESS_TOKEN: 'fixture-token', QL_LANG: 'en', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 12000);
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(stdin);
  });
  return { root, requests, run, reply: value => { reply = value; } };
}
function success(result) { assert.equal(result.code, 0, result.err); return JSON.parse(result.out); }

test('dashboard record sends execution statistics and rejects a missing body before HTTP', async t => {
  const f = await fixture(t);
  const payload = { ref_id: 7, code: 0, elapsed: 1.5 };
  success(await f.run(['dashboard', 'record', '--data', '-'], JSON.stringify(payload)));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'POST');
  assert.equal(f.requests[0].url, '/panel/open/dashboard/record');
  assert.deepEqual(JSON.parse(f.requests[0].body), payload);
  assert.equal((await f.run(['dashboard', 'record'])).code, 2);
  assert.equal(f.requests.length, 1);
});

test('OpenAPI catalogue covers every active registered backend route; retired 410 routes are explicit', async () => {
  const root = path.resolve(__dirname, '../../../back/api');
  const expected = [];
  const retired = new Set(['GET configs/:file', 'GET scripts/:file', 'GET logs/:file']);
  const index = await fs.readFile(path.join(root, 'index.ts'), 'utf8');
  for (const filename of await fs.readdir(root)) {
    if (!filename.endsWith('.ts') || filename === 'index.ts') continue;
    const source = await fs.readFile(path.join(root, filename), 'utf8');
    assert.ok(index.includes(`'./${filename.slice(0, -3)}'`), `Unregistered API module ${filename}`);
    const mount = /app\.use\(['"]([^'"]+)['"]/.exec(source);
    assert.ok(mount, filename);
    for (const m of source.matchAll(/route\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) {
      const endpoint = [mount[1], m[2]].join('/').split('/').filter(Boolean).join('/');
      const key = `${m[1].toUpperCase()} ${endpoint}`;
      if (!retired.has(key)) expected.push(key);
      else assert.match(source.slice(m.index, m.index + 200), /code: 410/);
    }
  }
  const actual = openOperations.map(op => `${op.method} ${op.path}`);
  assert.equal(new Set(actual).size, actual.length);
  assert.equal(new Set(openOperations.map(op => op.name)).size, openOperations.length);
  assert.deepEqual(actual.sort(), expected.sort());
});

test('task, subscription and app CRUD produce exact 2.x requests and protect app credentials', async t => {
  const f = await fixture(t);
  success(await f.run(['task', 'create', '--name', 'demo', '--command', 'task demo.js', '--schedule', '0 0 * * *']));
  assert.deepEqual(JSON.parse(f.requests.at(-1).body), { name: 'demo', command: 'task demo.js', schedule: '0 0 * * *' });
  assert.equal(f.requests.at(-1).method, 'POST'); assert.equal(f.requests.at(-1).url, '/panel/open/crons');
  success(await f.run(['task', 'update', '7', '--data', '-', '--name', 'updated'], '{"command":"task demo.js","schedule":"0 1 * * *"}'));
  assert.deepEqual(JSON.parse(f.requests.at(-1).body), { id: 7, name: 'updated', command: 'task demo.js', schedule: '0 1 * * *' });
  success(await f.run(['task', 'delete', '7', '8'])); assert.deepEqual(JSON.parse(f.requests.at(-1).body), [7, 8]);
  assert.equal(f.requests.at(-1).method, 'DELETE');
  success(await f.run(['subscription', 'create', '--type', 'public-repo', '--url', 'https://example.com/repo.git', '--alias', 'demo', '--schedule-type', 'crontab', '--schedule', '0 0 * * *']));
  assert.equal(f.requests.at(-1).url, '/panel/open/subscriptions');
  assert.equal(JSON.parse(f.requests.at(-1).body).schedule_type, 'crontab');
  const app = success(await f.run(['app', 'create', '--name', 'worker', '--scopes', 'crons,subscriptions']));
  assert.deepEqual(JSON.parse(f.requests.at(-1).body), { name: 'worker', scopes: ['crons', 'subscriptions'] });
  assert.equal(app.data.client_secret, undefined); assert.equal(app.data.tokens, undefined);
  assert.equal(success(await f.run(['app', 'reset-secret', '7', '--show-secrets'])).data.client_secret, 'SECRET-MARKER');
  assert.equal(f.requests.at(-1).url, '/panel/open/apps/7/reset-secret');
  for (const req of f.requests) assert.equal(req.headers.authorization, 'Bearer fixture-token');
});

test('all added named operations reach their registered method/path, including upload/download and anonymous routes', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'fixture.json'); await fs.writeFile(file, '{}');
  for (const op of openOperations.filter(op => !op.existing)) {
    const args = op.name.split(' ');
    for (const _ of op.params ?? []) args.push('7');
    if (op.body === 'ids') args.push('7', '8');
    else if (op.body) {
      const data = op.name.startsWith('task ') ? { command: 'echo fixture', schedule: '0 0 * * *' }
        : op.name.startsWith('subscription ') ? { type: 'file', url: 'https://example.com/job.js', alias: 'job', schedule_type: 'crontab' } : {};
      args.push('--data', JSON.stringify(data));
    }
    if (op.upload) args.push('--file', file);
    if (op.download) args.push('--output', path.join(f.root, op.name.replace(' ', '-') + '.out'));
    success(await f.run(args));
    const last = f.requests.at(-1);
    assert.equal(last.method, op.method, op.name);
    assert.equal(last.url, '/panel/open/' + op.path.replace(/:[A-Za-z]+/g, '7'), op.name);
    assert.equal(last.headers.authorization, op.anonymous ? undefined : 'Bearer fixture-token', op.name);
    if (op.upload) assert.ok(last.body.includes(`name="${op.upload}"; filename="fixture.json"`), op.name);
  }
});

test('raw route access retains query/body capabilities and rejects unsupported paths before authentication', async t => {
  const f = await fixture(t);
  success(await f.run(['api', 'request', 'GET', '/open/crons', '--query', '{"searchValue":"a & b","page":2}']));
  assert.equal(f.requests.at(-1).url, '/panel/open/crons?searchValue=a+%26+b&page=2');
  const bodyFile = path.join(f.root, 'env.json'); await fs.writeFile(bodyFile, '[{"name":"A","value":"B"}]');
  success(await f.run(['env', 'create', '--data', '@' + bodyFile]));
  assert.equal(f.requests.at(-1).body, '[{"name":"A","value":"B"}]');
  const count = f.requests.length;
  for (const args of [
    ['api', 'request', 'GET', 'https://example.com'], ['api', 'request', 'DELETE', 'auth/token'],
    ['api', 'request', 'GET', '../api/user'], ['api', 'request', 'GET', 'crons/0'], ['api', 'request', 'GET', 'crons/9007199254740993'],
    ['task', 'create', '--data', '{'], ['task', 'create', '--command', 'echo fixture'],
    ['task', 'update', '7', '--data', '{"id":8}'], ['task', 'delete', '-1'],
    ['env', 'list', '--query', '{"secret":{"value":1}}'],
    ['app', 'create', '--data', '{"name":"A"}', '--name', 'B'],
    ['log', 'download', '--data', '{}', '--output', bodyFile],
  ]) { const result = await f.run(args); assert.equal(result.code, 2, JSON.stringify(args) + result.err); assert.equal(result.out, ''); }
  assert.equal(f.requests.length, count);
  const output = path.join(f.root, 'download.json');
  success(await f.run(['log', 'download', '--data', '{"filename":"fixture.json"}', '--output', output]));
  assert.equal(await fs.readFile(output, 'utf8'), '{"fixture":true}');
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
});

test('POST/DELETE uncertainty and permission failures never retry or print server secrets', async t => {
  const f = await fixture(t);
  f.reply((_req, res) => { res.writeHead(503); res.end('SERVER-SECRET'); });
  for (const args of [['task', 'create', '--command', 'echo fixture', '--schedule', '0 0 * * *'], ['task', 'delete', '7']]) {
    const count = f.requests.length; const result = await f.run(args);
    assert.equal(result.code, 1); assert.match(result.err, /unknown|retry/i);
    assert.doesNotMatch(result.err, /SERVER-SECRET/); assert.equal(f.requests.length, count + 1);
  }
  f.reply((_req, res) => { res.writeHead(403); res.end('SERVER-SECRET'); });
  const result = await f.run(['app', 'list']); assert.equal(result.code, 3); assert.match(result.err, /apps/);
  assert.doesNotMatch(result.err, /SERVER-SECRET/);
});

test('failed downloads leave no partial files and timed-out mutations are not replayed', async t => {
  const f = await fixture(t);
  const output = path.join(f.root, 'partial.log');
  f.reply((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('partial');
    setTimeout(() => res.destroy(), 50);
  });
  const failed = await f.run(['log', 'download', '--data', '{"filename":"fixture.log"}', '--output', output]);
  assert.equal(failed.code, 1); assert.equal(failed.out, '');
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  f.reply(() => {});
  const count = f.requests.length;
  const timeout = await f.run(['app', 'create', '--name', 'fixture', '--scopes', 'crons', '--timeout', '1']);
  assert.equal(timeout.code, 1); assert.match(timeout.err, /unknown/);
  assert.equal(f.requests.length, count + 1);
});

test('owner two-factor challenge remains actionable without exposing server messages', async t => {
  const f = await fixture(t);
  f.reply((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"code":420,"message":"SERVER-SECRET"}'); });
  const result = await f.run(['user', 'login', '--data', '{"username":"fixture","password":"fixture"}']);
  assert.equal(result.code, 3); assert.match(result.err, /two-factor-login/); assert.doesNotMatch(result.err, /SERVER-SECRET/);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].headers.authorization, undefined);
});
