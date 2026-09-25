const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createContext } = require('../../dist/internal/runtime/context');
const { syncRaw } = require('../../dist/internal/subscription/subscriptionRunner');
const { runProcess } = require('../../dist/internal/runtime/process');

test('raw subscriptions retain legacy netrc authentication and preserve files on denied access', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-raw-netrc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const password = randomUUID();
  const authorization =
    'Basic ' + Buffer.from('fixture:' + password).toString('base64');
  let denied = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/public.js') return res.end('public script');
    if (denied || req.headers.authorization !== authorization)
      return res
        .writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
        .end();
    res.end('private script');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const env = { PATH: process.env.PATH, HOME: root, QL_LANG: 'en' };
  await fs.writeFile(
    path.join(root, '.netrc'),
    `machine 127.0.0.1 login fixture password ${password}\n`,
    { mode: 0o600 },
  );
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  if (process.env.QL_WGET_COMPARE === '1') {
    const original = await runProcess(
      'wget',
      ['-q', '-O', path.join(root, 'original.js'), endpoint + '/private.js'],
      { env },
    );
    assert.equal(
      original.code,
      0,
      'retained Shell wget authentication must work',
    );
    assert.equal(
      await fs.readFile(path.join(root, 'original.js'), 'utf8'),
      'private script',
    );
  }
  const context = createContext({ root }, env);
  const input = {
    url: endpoint + '/private.js',
    autoAdd: false,
    autoDelete: false,
  };
  const result = await syncRaw(context, input);
  const destination = path.join(context.paths.dir_scripts, result.file);
  assert.equal(await fs.readFile(destination, 'utf8'), 'private script');
  denied = true;
  await assert.rejects(syncRaw(context, input));
  assert.equal(await fs.readFile(destination, 'utf8'), 'private script');
  assert.equal(
    (await fs.readdir(context.paths.dir_raw)).filter((x) => x.endsWith('.tmp'))
      .length,
    0,
  );
  await fs.rm(path.join(root, '.netrc'));
  await assert.rejects(syncRaw(context, input));
  const publicResult = await syncRaw(context, {
    ...input,
    url: endpoint + '/public.js',
  });
  assert.equal(
    await fs.readFile(
      path.join(context.paths.dir_scripts, publicResult.file),
      'utf8',
    ),
    'public script',
  );
});
