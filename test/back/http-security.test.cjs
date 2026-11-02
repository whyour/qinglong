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
  for (const dir of ['config/grpc', 'scripts', 'upload', 'tmp', 'bak'])
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config/grpc/client.key'), 'SENTINEL');
  fs.writeFileSync(path.join(tmp, 'config/normal.txt'), 'normal');
  fs.writeFileSync(path.join(tmp, 'config/config.sh'), 'original');
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
    dataPath: tmp,
    configPath: path.join(tmp, 'config/'),
    scriptPath: path.join(tmp, 'scripts/'),
    uploadPath: path.join(tmp, 'upload'),
    tmpPath: path.join(tmp, 'tmp'),
    bakPath: path.join(tmp, 'bak'),
    writePathList: [path.join(tmp, 'scripts')],
    blackFileList: ['auth.json', 'grpc'],
    baseUrl: '/panel',
  };
  const apps = [
    {
      scopes: ['configs'],
      tokens: [{ value: 'config-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      scopes: ['configs:read'],
      tokens: [{ value: 'config-read-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      scopes: ['configs', 'scripts'],
      tokens: [
        { value: 'script-config-app', expiration: Date.now() / 1000 + 3600 },
      ],
    },
    {
      scopes: ['scripts'],
      tokens: [{ value: 'script-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      scopes: ['scripts:read'],
      tokens: [{ value: 'script-read-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      scopes: ['envs'],
      tokens: [{ value: 'env-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      scopes: ['envs:read'],
      tokens: [{ value: 'env-read-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      name: 'external-system',
      scopes: ['system'],
      tokens: [{ value: 'system-app', expiration: Date.now() / 1000 + 3600 }],
    },
    {
      name: 'system',
      scopes: ['system'],
      tokens: [{ value: 'internal-system', expiration: Date.now() / 1000 + 3600 }],
    },
  ];
  let resetCalls = 0;
  let commandCalls = 0;
  let envWriteCalls = 0;
  let initialized = 0;
  const User = class {};
  const Script = class {
    getFile(folder, filename) {
      return fs.promises.readFile(path.join(config.scriptPath, folder, filename), 'utf8');
    }
    checkFilePath(folder, filename) {
      return path.join(config.scriptPath, folder || '', filename);
    }
  };
  const script = new Script();
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
      fileExist: (p) => fs.existsSync(p),
      rmPath: (p) => fs.promises.rm(p),
    },
    '../shared/i18n': { t: (x) => x },
    '../shared/store': {
      shareStore: { getAuthInfo: async () => auth, getApps: async () => apps },
    },
    '../config/serverEnv': { serveEnv: (_req, res) => res.end() },
    '../services/user': User,
    '../services/script': Script,
    '../data/open': {},
    '../data/system': {},
    typedi: { Service: () => (x) => x },
  };
  const Config = load(path.join(__dirname, '../../back/services/config.ts'), {
    ...mocks,
    typedi: { Service: () => (x) => x },
  }).default;
  const configService = new Config();
  mocks['../services/config'] = Config;
  const historyCache = new Map();
  const History = load(
    path.join(__dirname, '../../back/services/scriptHistory.ts'),
    mocks,
    historyCache,
  ).default;
  const history = new History();
  mocks.typedi = {
    ...mocks.typedi,
    Container: {
      get: (x) =>
        x === User ? user : x === History ? history : x === Script ? script : configService,
    },
  };
  mocks['../api'] = () => {
    const router = express.Router();
    load(path.join(__dirname, '../../back/api/user.ts'), mocks).default(router);
    load(path.join(__dirname, '../../back/api/config.ts'), mocks).default(
      router,
    );
    load(
      path.join(__dirname, '../../back/api/script.ts'),
      mocks,
      historyCache,
    ).default(router);
    router.get('/envs', (_req, res) => res.json({ code: 200 }));
    router.post('/envs', (_req, res) => {
      envWriteCalls++;
      res.json({ code: 200 });
    });
    router.get('/system', (_req, res) => res.json({ code: 200 }));
    router.put('/system/notify', (_req, res) => res.json({ code: 200 }));
    router.put('/system/auth/reset', (_req, res) => {
      resetCalls++;
      res.json({ code: 200 });
    });
    router.put('/system/command-run', (_req, res) => {
      commandCalls++;
      res.json({ code: 200 });
    });
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
  assert.equal((await request('/open/envs', 'env-read-app')).body.code, 200);
  for (const prefix of ['/open', '/panel/open']) {
    assert.equal(
      (await request(`${prefix}/envs`, 'env-read-app', 'POST', [
        { name: 'SAFE_VALUE', value: 'kept' },
      ])).status,
      401,
    );
  }
  assert.equal(envWriteCalls, 0);
  assert.equal(
    (await request('/open/envs', 'env-app', 'POST', [
      { name: 'SAFE_VALUE', value: 'kept' },
    ])).body.code,
    200,
  );
  assert.equal(envWriteCalls, 1);
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
    (await request('/open/configs/detail?path=normal.txt', 'config-read-app'))
      .body.data,
    'normal',
  );
  for (const prefix of ['/open', '/panel/open']) {
    for (const name of ['normal.txt', 'config.sh', 'task_before.sh']) {
      assert.equal(
        (await request(`${prefix}/configs/save`, 'config-read-app', 'POST', {
          name,
          content: 'untrusted',
        })).status,
        401,
      );
    }
  }
  assert.equal(fs.readFileSync(path.join(tmp, 'config/config.sh'), 'utf8'), 'original');
  assert.equal((await request('/open/system', 'system-app')).body.code, 200);
  assert.equal(
    (await request('/open/system/notify', 'system-app', 'PUT', {
      title: 'title',
      content: 'content',
    })).body.code,
    200,
  );
  for (const prefix of ['/open', '/panel/open']) {
    assert.equal(
      (await request(`${prefix}/system/auth/reset`, 'system-app', 'PUT', {
        password: 'changed',
      })).status,
      401,
    );
    assert.equal(
      (await request(`${prefix}/system/command-run`, 'system-app', 'PUT', {
        command: 'id',
      })).status,
      401,
    );
  }
  assert.equal(resetCalls, 0);
  assert.equal(commandCalls, 0);
  assert.equal(
    (await request('/open/system/auth/reset', 'internal-system', 'PUT', {
      retries: 0,
    })).body.code,
    200,
  );
  assert.equal(
    (await request('/api/system/auth/reset', valid, 'PUT', { retries: 0 })).body.code,
    200,
  );
  assert.equal(resetCalls, 2);
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
  const scriptName = 'data/scripts/test.js';
  for (const prefix of ['/open', '/panel/open']) {
    const denied = await request(
      `${prefix}/configs/save`,
      'config-app',
      'POST',
      {
        name: scriptName,
        content: 'overwrite',
      },
    );
    assert.equal(denied.body.code, 403);
    assert.equal(fs.existsSync(path.join(tmp, 'scripts/test.js')), false);
  }
  assert.equal(
    (
      await request('/open/configs/save', 'script-config-app', 'POST', {
        name: scriptName,
        content: 'authorized script',
      })
    ).body.code,
    403,
  );
  assert.equal(fs.existsSync(path.join(tmp, 'scripts/test.js')), false);
  assert.equal(
    (await request(`/open/configs/detail?path=${scriptName}`, 'config-app'))
      .body.code,
    403,
  );
  assert.equal(
    (
      await request('/open/configs/save', 'config-app', 'POST', {
        name: 'normal.txt',
        content: 'normal config',
      })
    ).body.code,
    200,
  );
  assert.equal(
    (await request('/api/configs/save', valid, 'POST', {
      name: 'config.sh',
      content: 'owner config',
    })).body.code,
    200,
  );
  assert.equal(fs.readFileSync(path.join(tmp, 'config/config.sh'), 'utf8'), 'owner config');
  assert.equal(
    (
      await request('/api/configs/save', valid, 'POST', {
        name: scriptName,
        content: 'owner script',
      })
    ).body.code,
    403,
  );
  for (const prefix of ['/open', '/panel/open']) {
    assert.equal(
      (
        await request(`${prefix}/scripts`, 'config-app', 'POST', {
          filename: 'test.js',
          content: 'unauthorized',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(`${prefix}/scripts`, 'script-read-app', 'POST', {
          filename: 'test.js',
          content: 'unauthorized',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(`${prefix}/scripts`, 'script-app', 'POST', {
          filename: 'test.js',
          content: 'authorized script',
        })
      ).body.code,
      200,
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, 'scripts/test.js'), 'utf8'),
      'authorized script',
    );
  }
  assert.equal(
    (await request('/open/scripts/detail?file=test.js', 'script-read-app')).body
      .data,
    'authorized script',
  );
  const downloaded = await fetch(
    `http://127.0.0.1:${server.address().port}/open/scripts/download`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer script-read-app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: 'test.js' }),
    },
  );
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'authorized script');
  for (const method of ['PUT', 'DELETE']) {
    assert.equal(
      (await request('/open/scripts', 'script-read-app', method, {
        filename: 'test.js', content: 'unauthorized',
      })).status,
      401,
    );
  }
  for (const path of ['run', 'stop', 'rename', 'history/restore']) {
    assert.equal(
      (await request(`/open/scripts/${path}`, 'script-read-app', 'PUT', {
        filename: 'test.js', content: 'unauthorized',
      })).status,
      401,
    );
  }
});
