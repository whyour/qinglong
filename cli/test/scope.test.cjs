const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { inspectPanel } = require('../dist/local/check');

test('public task entries retain no-argument script discovery and help stays read-only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-public-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data/scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/scripts/job.js'), 'throw Error("do not execute"); const $ = new Env("Job");');
  for (const [entry, args] of [['task', []], ['ql', ['task']]]) {
    const run = (...extra) => spawnSync(process.execPath, [path.resolve(__dirname, `../dist/${entry}.js`), ...args, ...extra, '--json'], { env: { PATH: process.env.PATH, QL_DIR: root }, encoding: 'utf8' });
    const listing = run();
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(JSON.parse(listing.stdout).data.scripts, [{ file: 'job.js', name: 'Job' }]);
    assert.equal(JSON.parse(run('--help').stdout).data.scripts, undefined);
  }
});

test('removed development publication is rejected before doing any work', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/ql.js'), 'dev', 'release', '--root', '/absent', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 2);
});

test('health probes use the base path and reject failed or malformed scheduler health', async (t) => {
  let health = { status: 503, body: { code: 503, data: { status: 'error' } } };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/ql/api/health?')) {
      res.statusCode = health.status;
      res.end(JSON.stringify(health.body));
    } else if (req.url === '/ql/') res.end('<div id="root"></div>');
    else res.end('{"code":200,"data":{"version":"2.21.0"}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const context = { env: { QlPort: String(server.address().port), QlBaseUrl: '/ql/' } };
  assert.equal((await inspectPanel(context)).backend.healthy, false);
  health = { status: 200, body: { code: 200, data: {} } };
  assert.equal((await inspectPanel(context)).backend.healthy, false);
  health = { status: 200, body: { code: 200, data: { status: 'ok' } } };
  assert.equal((await inspectPanel(context)).backend.healthy, true);
  assert.equal(seen.some(route => route.includes('/api/system')), false);
});
