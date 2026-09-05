const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const load = require('../helpers/load-security-module.cjs');

test('HTTP authentication protects init, scopes, expired sessions and config secrets', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-http-security-'));
  for (const dir of ['config/grpc', 'scripts', 'upload', 'tmp'])
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config/grpc/client.key'), 'SENTINEL');
  fs.writeFileSync(path.join(tmp, 'config/normal.txt'), 'normal');
  const secret = 'http-security-test';
  const valid = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: '1h' });
  const expired = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: -1 });
  const auth = {
    username: 'owner',
    password: 'configured',
    token: valid,
    tokens: { desktop: [{ value: expired }] },
  };
  const configSource = fs.readFileSync(
    path.join(__dirname, '../../back/config/index.ts'),
    'utf8',
  );
  const whitelistSource = configSource
    .slice(configSource.indexOf('apiWhiteList:'))
    .match(/apiWhiteList:\s*\[([\s\S]*?)\]/)[1];
  const config = {
    api: { prefix: '/api' },
    apiWhiteList: [...whitelistSource.matchAll(/['"]([^'"]+)['"]/g)].map(
      (x) => x[1],
    ),
    jwt: { secret },
    rootPath: tmp,
    configPath: path.join(tmp, 'config/'),
    scriptPath: path.join(tmp, 'scripts/'),
    uploadPath: path.join(tmp, 'upload'),
    tmpPath: path.join(tmp, 'tmp'),
    blackFileList: ['auth.json', 'grpc'],
    baseUrl: '/panel',
  };
  const apps = [
    {
      scopes: ['configs'],
      tokens: [{ value: 'config-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      scopes: ['envs'],
      tokens: [{ value: 'env-app', expiration: Date.now() / 1000 + 3600 }],
    },
  ];
  let initialized = 0;
  const User = class {};
  const user = {
    initializeUser: async () => {
      initialized++;
      return { code: 200 };
    },
    getAuthInfo: async () => auth,
  };
  const mocks = {
    '../config': config,
    '../config/util': {
      getToken: (r) => (r.headers.authorization || '').replace(/^Bearer /, ''),
      getPlatform: () => 'desktop',
      getFileContentByName: (p) => fs.promises.readFile(p, 'utf8'),
    },
    '../shared/i18n': { t: (x) => x },
    '../shared/store': {
      shareStore: { getAuthInfo: async () => auth, getApps: async () => apps },
    },
    '../config/serverEnv': { serveEnv: (_req, res) => res.end() },
    '../services/user': User,
    '../data/open': {},
    '../data/system': {},
    '../shared/utils': {
      writeFileWithLock: (p, content) => fs.promises.writeFile(p, content),
    },
  };
  const Config = load(path.join(__dirname, '../../back/services/config.ts'), {
    ...mocks,
    typedi: { Service: () => (x) => x },
  }).default;
  const configService = new Config();
  mocks['../services/config'] = Config;
  mocks.typedi = {
    Container: { get: (x) => (x === User ? user : configService) },
  };
  mocks['../api'] = () => {
    const router = express.Router();
    load(path.join(__dirname, '../../back/api/user.ts'), mocks).default(router);
    load(path.join(__dirname, '../../back/api/config.ts'), mocks).default(
      router,
    );
    router.get('/envs', (_req, res) => res.json({ code: 200 }));
    return router;
  };
  const app = express();
  load(path.join(__dirname, '../../back/loaders/express.ts'), mocks).default({
    app,
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const request = async (url, token, method = 'GET', body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${url}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  for (const url of [
    '/api/user/init',
    '/open/user/init',
    '/panel/api/user/init',
    '/panel/open/user/init',
  ]) {
    const response = await request(url, undefined, 'PUT', {
      username: 'attacker',
      password: 'changed',
    });
    assert.equal(response.body.code, 450, url);
  }
  assert.equal(initialized, 0);
  assert.equal(
    (
      await request('/api/user/login', undefined, 'POST', {
        username: 'x',
        password: 'x'.repeat(20000),
      })
    ).status,
    413,
  );
  fs.writeFileSync(
    path.join(tmp, 'upload/legacy.html'),
    '<script>window.test=1</script>',
  );
  const legacyUpload = await fetch(
    `http://127.0.0.1:${server.address().port}/api/static/legacy.html`,
  );
  assert.equal(legacyUpload.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    legacyUpload.headers.get('content-security-policy'),
    "sandbox; default-src 'none'",
  );
  for (const prefix of ['/api', '/open', '/panel/api', '/panel/open']) {
    assert.equal(
      (await request(`${prefix}/envs`, expired)).status,
      401,
      prefix,
    );
    assert.equal(
      (await request(`${prefix}/envs`, valid)).body.code,
      200,
      prefix,
    );
    assert.equal((await request(`${prefix}/envs`)).status, 401, prefix);
  }
  assert.equal((await request('/open/envs', 'env-app')).body.code, 200);
  assert.equal(
    (await request('/open/configs/detail?path=normal.txt', 'env-app')).status,
    401,
  );
  assert.equal(
    (await request('/open/configs/detail?path=normal.txt', 'config-app')).body
      .data,
    'normal',
  );
  assert.equal(
    (await request('/open/configs/detail?path=grpc/client.key', 'config-app'))
      .body.code,
    403,
  );
  assert.equal(
    (
      await request('/open/configs/save', 'config-app', 'POST', {
        name: 'grpc/client.key',
        content: 'changed',
      })
    ).body.code,
    403,
  );
  assert.equal(
    fs.readFileSync(path.join(tmp, 'config/grpc/client.key'), 'utf8'),
    'SENTINEL',
  );
  assert.equal(
    (
      await request('/Api/user/init', undefined, 'PUT', {
        username: 'x',
        password: 'y',
      })
    ).status,
    400,
  );
});
