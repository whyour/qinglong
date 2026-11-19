const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const undici = require('undici');
const nodemailer = require('nodemailer');
const load = require('../helpers/load-security-module.cjs');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('security upgrades preserve JSON, gzip, multipart and HTTP redirect handling', async (t) => {
  const app = express();
  app.post('/json', bodyParser.json(), (req, res) => res.json(req.body));
  app.post('/upload', multer().single('file'), (req, res) => {
    res.json({ name: req.body.name, content: req.file.buffer.toString() });
  });
  app.get('/redirect', (_req, res) => res.redirect('/result'));
  app.get('/result', (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 400).send(error.message),
  );
  const base = await listen(t, app);
  const value = { name: '中文', nested: { enabled: true } };
  for (const compressed of [false, true]) {
    const response = await undici.fetch(`${base}/json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
      },
      body: compressed
        ? gzipSync(JSON.stringify(value))
        : JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), value);
  }
  const malformed = await undici.fetch(`${base}/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: Buffer.concat([gzipSync('{}'), Buffer.from('trailing garbage')]),
  });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const form = new undici.FormData();
  form.set('name', 'script');
  form.set('file', new Blob(['console.log("safe")']), 'test.js');
  const upload = await undici.fetch(`${base}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(upload.status, 200, await upload.clone().text());
  assert.deepEqual(await upload.json(), {
    name: 'script',
    content: 'console.log("safe")',
  });
  const redirected = await undici.fetch(`${base}/redirect`);
  assert.deepEqual(await redirected.json(), { ok: true });
  const axios = require('axios');
  assert.deepEqual(
    (await axios.get(`${base}/redirect`, { proxy: false })).data,
    { ok: true },
  );
});

test('Nodemailer still composes named recipients, Unicode subjects and HTML', async () => {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
  try {
    const info = await transport.sendMail({
      from: '"青龙快讯" <sender@example.test>',
      to: ['"Last, First" <first@example.test>', 'second@example.test'],
      subject: '安全升级测试',
      html: 'line one<br/>line two',
    });
    assert.deepEqual(info.envelope.to, [
      'first@example.test',
      'second@example.test',
    ]);
    assert.ok(info.messageId);
    assert.match(info.message.toString(), /Content-Type: text\/html/);
    assert.match(info.message.toString(), /line one<br\/>line two/);
  } finally {
    transport.close();
  }
});

test('CommonJS query-string consumers retain safe decoding with the ESM compatibility patch', () => {
  const query = require('query-string');
  assert.deepEqual(
    { ...query.parse('text=%E4%B8%AD%E6%96%87&bad=%E0%A4%A&plus=a%2Bb') },
    {
      bad: '%E0%A4%A',
      plus: 'a+b',
      text: '中文',
    },
  );
  const localRequire = createRequire(require.resolve('query-string'));
  const decode = localRequire('decode-uri-component');
  assert.equal(typeof decode, 'function');
  // A long malformed run previously caused quadratic replacement work.
  const input = '%FF%41'.repeat(20000);
  assert.equal(decode(input), '%FFA'.repeat(20000));
});

test('tar keeps the streaming API used by sqlite native package installation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-tar-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'binding.node'), 'fixture');
  const sqliteRequire = createRequire(require.resolve('sqlite3'));
  const tar = sqliteRequire('tar');
  const chunks = [];
  for await (const chunk of tar.create({ cwd: source, gzip: true }, [
    'binding.node',
  ]))
    chunks.push(chunk);
  const extractor = tar.extract({ cwd: target });
  const completed = once(extractor, 'close');
  Readable.from(Buffer.concat(chunks)).pipe(extractor);
  await completed;
  assert.equal(
    fs.readFileSync(path.join(target, 'binding.node'), 'utf8'),
    'fixture',
  );
});

for (const entry of [
  {
    file: 'config',
    prefix: 'configs',
    route: '/files',
    method: 'get',
    limit: 600,
  },
  {
    file: 'log',
    prefix: 'logs',
    route: '/download',
    method: 'post',
    limit: 600,
    body: { filename: 'a.log', path: '' },
  },
  {
    file: 'script',
    prefix: 'scripts',
    route: '/download',
    method: 'post',
    limit: 600,
    body: { filename: 'a.js' },
  },
  {
    file: 'script',
    prefix: 'scripts',
    route: '/rename',
    method: 'put',
    limit: 600,
    body: { filename: 'a.js', newFilename: 'b.js', path: '' },
  },
  {
    file: 'system',
    prefix: 'system',
    route: '/auth/reset',
    method: 'put',
    limit: 60,
    body: {},
  },
]) {
  test(`${entry.prefix}${entry.route} limits work across API aliases before the handler`, async (t) => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const mocks = {
      '../config': { tmpPath: os.tmpdir() },
      '../config/util': {},
      '../services/config': {},
      '../services/log': {},
      '../services/script': {},
      '../services/scriptHistory': {},
      '../services/system': {},
      '../services/user': {},
      '../shared/logStreamManager': {},
      '../shared/i18n': { t: (x) => x },
      '../data/runningInstance': {},
    };
    load(path.resolve(`back/api/${entry.file}.ts`), mocks).default(router);
    const mounted = router.stack.find(
      (layer) => layer.name === 'router',
    ).handle;
    const selected = mounted.stack.find(
      (layer) =>
        layer.route?.path === entry.route && layer.route.methods[entry.method],
    ).route;
    let calls = 0;
    selected.stack.at(-1).handle = (_req, res) => {
      calls++;
      res.json({ code: 200 });
    };
    app.use('/api', router);
    app.use('/open', router);
    const base = await listen(t, app);
    for (let i = 0; i <= entry.limit; i++) {
      const response = await fetch(
        `${base}/${i % 2 ? 'api' : 'open'}/${entry.prefix}${entry.route}`,
        {
          method: entry.method.toUpperCase(),
          headers: { 'Content-Type': 'application/json' },
          ...(entry.body ? { body: JSON.stringify(entry.body) } : {}),
        },
      );
      await response.text();
      assert.equal(response.status, i < entry.limit ? 200 : 429);
    }
    assert.equal(calls, entry.limit);
  });
}

test('Dva Immer integration preserves draft updates and Redux-style replacement', () => {
  const maxRequire = createRequire(require.resolve('@umijs/max/package.json'));
  const pluginRequire = createRequire(
    maxRequire.resolve('@umijs/plugins/package.json'),
  );
  const plugin = pluginRequire('dva-immer').default();
  const initial = { nested: { count: 1 } };
  const reducer = plugin._handleActions(
    {
      increment: (draft) => {
        draft.nested.count++;
      },
      replace: () => ({ nested: { count: 5 } }),
    },
    initial,
  );
  assert.deepEqual(reducer(undefined, { type: 'increment' }), {
    nested: { count: 2 },
  });
  assert.equal(initial.nested.count, 1);
  assert.deepEqual(reducer(initial, { type: 'replace' }), {
    nested: { count: 5 },
  });
});

test('ProLayout keeps route matching with the patched path-to-regexp API', () => {
  const layoutRequire = createRequire(
    require.resolve('@ant-design/pro-layout'),
  );
  const pathToRegexp = layoutRequire('path-to-regexp');
  const keys = [];
  const matcher = pathToRegexp('/scripts/:name?', keys, { end: true });
  assert.equal(keys[0].name, 'name');
  assert.ok(matcher.test('/scripts'));
  assert.ok(matcher.test('/scripts/demo'));
  assert.equal(matcher.test('/scripts/demo/extra'), false);
});

test('script uploads and finish cleanup reject paths outside the temporary directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-upload-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    tmpPath: path.join(root, 'tmp'),
    scriptPath: path.join(root, 'scripts'),
    configPath: path.join(root, 'config'),
    blackFileList: ['auth.json'],
  };
  config.writePathList = [config.scriptPath, config.configPath];
  for (const dir of [
    config.tmpPath,
    config.scriptPath,
    config.configPath,
    path.join(root, 'tmp-sibling'),
  ])
    fs.mkdirSync(dir);
  const sentinel = path.join(root, 'tmp-sibling', 'sentinel');
  fs.writeFileSync(sentinel, 'outside');
  const alias = path.join(config.tmpPath, 'outside-link');
  fs.symlinkSync(sentinel, alias);
  const app = express.Router();
  load(path.resolve('back/api/script.ts'), {
    '../config': config,
    '../services/script': {},
    '../services/scriptHistory': {},
    '../shared/i18n': { t: (x) => x },
    '../config/util': {},
  }).default(app);
  const mounted = app.stack.find((layer) => layer.name === 'router').handle;
  const route = mounted.stack.find(
    (layer) => layer.route?.path === '/' && layer.route.methods.post,
  ).route;
  for (const uploaded of [
    sentinel,
    alias,
    path.join(config.tmpPath, '..', 'tmp-sibling', 'sentinel'),
  ]) {
    let result;
    let finish;
    const req = { body: { filename: 'received.js' }, file: { path: uploaded } };
    const res = {
      on: (_event, callback) => {
        finish = callback;
      },
      send: (value) => {
        result = value;
      },
    };
    route.stack[0].handle(req, res, () => {});
    await route.stack.at(-1).handle(req, res, (error) => {
      throw error;
    });
    finish();
    await new Promise(setImmediate);
    assert.equal(result.code, 403);
    assert.equal(
      fs.existsSync(path.join(config.scriptPath, 'received.js')),
      false,
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  }
});

test('React Router keeps nested navigation and redirects with its declared router dependency', async () => {
  const { createMemoryRouter, redirect } = require('react-router-dom');
  const router = createMemoryRouter(
    [
      { path: '/', id: 'home' },
      {
        path: '/scripts/:name',
        id: 'script',
        loader: ({ params }) => params.name,
      },
      { path: '/legacy', loader: () => redirect('/scripts/demo?from=legacy') },
    ],
    { initialEntries: ['/'] },
  );
  try {
    await router.navigate('/scripts/example?mode=edit');
    assert.equal(router.state.location.pathname, '/scripts/example');
    assert.equal(router.state.location.search, '?mode=edit');
    assert.equal(router.state.loaderData.script, 'example');
    await router.navigate('/legacy');
    assert.equal(router.state.location.pathname, '/scripts/demo');
    assert.equal(router.state.loaderData.script, 'demo');
    // History navigation returns before its loader completes.
    await new Promise((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (state.navigation.state === 'idle') {
          unsubscribe();
          resolve();
        }
      });
      router.navigate(-1);
    });
    assert.equal(router.state.location.pathname, '/scripts/example');
  } finally {
    router.dispose();
  }
});
