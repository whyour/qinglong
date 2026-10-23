const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const express = require('express');
const jwt = require('jsonwebtoken');
const load = require('../helpers/load-security-module.cjs');

test('authentication cache propagates database read and write failures', async () => {
  const failure = new Error('synthetic unavailable database');
  const CacheStore = load(path.resolve('back/data/cacheStore.ts'), {
    '.': {
      database: {
        request: async () => {
          throw failure;
        },
      },
    },
  }).CacheStore;
  const { shareStore } = load(path.resolve('back/shared/store.ts'), {
    '../data/cacheStore': { CacheStore },
  });
  await assert.rejects(shareStore.getAuthInfo(), (error) => error === failure);
  await assert.rejects(
    shareStore.updateAuthInfo({ username: 'qa' }),
    (error) => error === failure,
  );
});

test('HTTP authentication distinguishes unavailable storage from an invalid session', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-auth-availability-'),
  );
  const secret = 'synthetic-auth-availability';
  const token = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: '1h' });
  const auth = { username: 'qa', password: 'configured', token };
  let unavailable = false;
  let initialized = 0;
  const read = async (value) => {
    if (unavailable) throw new Error(`SQL failure must not expose ${token}`);
    return value;
  };
  const router = express.Router();
  router.get('/system/update-status', (_req, res) => res.json({ code: 200 }));
  router.get('/envs', (_req, res) => res.json({ code: 200 }));
  router.get('/health', (_req, res) => res.json({ code: 200 }));
  router.put('/user/init', (_req, res) => {
    initialized++;
    res.json({ code: 200 });
  });
  const app = express();
  load(path.resolve('back/loaders/express.ts'), {
    '../config': {
      rootPath: root,
      uploadPath: path.join(root, 'upload'),
      configPath: path.join(root, 'config'),
      api: { prefix: '/api' },
      apiWhiteList: ['/api/health', '/api/user/init'],
      jwt: { secret },
    },
    '../api': () => router,
    '../config/util': {
      getToken: (req) =>
        (req.headers.authorization || '').replace(/^Bearer /, ''),
      getPlatform: () => 'desktop',
    },
    '../shared/store': {
      shareStore: {
        getAuthInfo: () => read(auth),
        getApps: () =>
          read([
            {
              scopes: ['envs'],
              tokens: [
                { value: 'app-token', expiration: Date.now() / 1000 + 3600 },
              ],
            },
          ]),
      },
    },
    '../shared/i18n': { t: (value) => value },
    '../config/serverEnv': { serveEnv: (_req, res) => res.end() },
    '../data/open': {},
    '../data/system': {},
  }).default({ app });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (route, value, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${route}`,
      {
        method,
        headers: value ? { Authorization: `Bearer ${value}` } : {},
        signal: AbortSignal.timeout(3000),
      },
    );
    return { status: response.status, body: await response.text() };
  };
  assert.equal((await request('/api/system/update-status', token)).status, 200);
  unavailable = true;
  for (const [route, value, method] of [
    ['/api/system/update-status', token],
    ['/open/envs', 'app-token'],
    ['/api/user/init', undefined, 'PUT'],
  ]) {
    const response = await request(route, value, method);
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).code, 503);
    assert.ok(!response.body.includes(token));
    assert.ok(!response.body.includes('SQL failure'));
  }
  assert.equal(initialized, 0);
  assert.equal((await request('/api/health')).status, 200);
  unavailable = false;
  assert.equal((await request('/api/system/update-status', token)).status, 200);
  const invalid = jwt.sign({ unrecognized: true }, secret, {
    algorithm: 'HS384',
    expiresIn: '1h',
  });
  assert.equal(
    (await request('/api/system/update-status', invalid)).status,
    401,
  );
});
