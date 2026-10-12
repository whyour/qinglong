const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  express = require('express');
const load = require('../helpers/load-security-module.cjs');
test('unknown API requests return JSON 404 while env.js and SPA deep links work', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'static/dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'static/dist/index.html'), 'SPA');
  const app = express();
  load('back/loaders/express.ts', {
    '../api': () => express.Router(),
    '../config': {
      rootPath: dir,
      uploadPath: dir,
      api: { prefix: '/api' },
      apiWhiteList: ['/api/env.js'],
      jwt: { secret: 'test' },
    },
    'express-jwt': {
      expressjwt: () => ({ unless: () => (_q, _r, next) => next() }),
      UnauthorizedError: class extends Error {},
    },
    '../config/util': {
      getPlatform: () => 'desktop',
      getToken: () => 'stored',
    },
    '../config/serverEnv': {
      serveEnv: (_q, r) => r.type('js').send('window.QL_CONFIG={};'),
    },
    '../shared/store': {
      shareStore: { getAuthInfo: async () => ({}), getApps: async () => [] },
    },
    '../shared/auth': {
      isValidToken: () => true,
      isDefaultAuthInfo: () => false,
    },
    '../shared/i18n': { t: (s) => s },
    '../middlewares/uniqueConstraintError': (_q, _r, next) => next(),
    '../middlewares/protectedPathCase': (_q, _r, next) => next(),
    '../data/system': {},
    '../data/open': {},
  }).default({ app });
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const p of ['/api', '/api/missing', '/open/missing']) {
    const res = await fetch(url + p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers.get('content-type'), /json/);
    assert.equal((await res.json()).code, 404);
  }
  const env = await fetch(url + '/api/env.js');
  assert.match(await env.text(), /QL_CONFIG/);
  assert.equal(await (await fetch(url + '/script')).text(), 'SPA');
});
