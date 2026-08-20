require('ts-node/register/transpile-only');
require('reflect-metadata');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Container } = require('typedi');

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ql3-legacy-http-compatibility-'),
);
const dataRoot = path.join(testRoot, 'data');
process.env.QL_DATA_DIR = dataRoot;
process.env.JWT_SECRET = 'ql3-legacy-http-compatibility-secret';
for (const directory of [
  'bak',
  'config',
  'db',
  'log',
  'scripts',
  'scripts-sibling',
  'upload',
]) {
  fs.mkdirSync(path.join(dataRoot, directory), { recursive: true });
}
fs.writeFileSync(path.join(dataRoot, 'scripts', 'existing.js'), 'existing\n');
fs.mkdirSync(path.join(dataRoot, 'scripts', 'jobs'), { recursive: true });
fs.writeFileSync(
  path.join(dataRoot, 'scripts-sibling', 'outside.js'),
  'must not be listed\n',
);
fs.symlinkSync(
  path.join(dataRoot, 'scripts-sibling'),
  path.join(dataRoot, 'scripts', 'outside-link'),
  'dir',
);

const shareStore = {
  async getApps() {
    return undefined;
  },
  async getAuthInfo() {
    return undefined;
  },
  async getLang() {
    return undefined;
  },
  async setLang() {},
  async updateApps() {},
  async updateAuthInfo() {},
};
const sharedStoreModulePath = require.resolve('../../back/shared/store');
require.cache[sharedStoreModulePath] = {
  id: sharedStoreModulePath,
  filename: sharedStoreModulePath,
  loaded: true,
  exports: { shareStore },
  children: [],
  paths: [],
};

const config = require('../../back/config').default;
const OpenService = require('../../back/services/open').default;
const ScriptService = require('../../back/services/script').default;
const SystemService = require('../../back/services/system').default;
const UserService = require('../../back/services/user').default;
const registerOpenRoutes = require('../../back/api/open').default;
const registerScriptRoutes = require('../../back/api/script').default;
const registerSystemRoutes = require('../../back/api/system').default;
const { isPathInside } = require('../../back/config/util');
const apiIndexModulePath = require.resolve('../../back/api');
require.cache[apiIndexModulePath] = {
  id: apiIndexModulePath,
  filename: apiIndexModulePath,
  loaded: true,
  exports: {
    __esModule: true,
    default() {
      const api = express.Router();
      registerScriptRoutes(api);
      registerOpenRoutes(api);
      registerSystemRoutes(api);
      return api;
    },
  },
  children: [],
  paths: [],
};
const expressLoader = require('../../back/loaders/express').default;

const calls = [];
const panelToken = jwt.sign({ data: 'panel-session' }, config.jwt.secret, {
  algorithm: 'HS384',
  expiresIn: '10m',
});
const foreignPanelToken = jwt.sign(
  { data: 'foreign-panel-session' },
  config.jwt.secret,
  { algorithm: 'HS384', expiresIn: '10m' },
);
const nowSeconds = Math.round(Date.now() / 1000);
const authInfo = {
  username: 'operator',
  password: 'changed',
  token: panelToken,
  tokens: { desktop: panelToken },
};
const apps = [
  {
    name: 'script-client',
    scopes: ['scripts'],
    tokens: [{ value: 'open-script-token', expiration: nowSeconds + 3_600 }],
  },
  {
    name: 'system-client',
    scopes: ['system'],
    tokens: [{ value: 'open-system-token', expiration: nowSeconds + 3_600 }],
  },
  {
    name: 'expired-client',
    scopes: ['scripts'],
    tokens: [{ value: 'expired-open-token', expiration: nowSeconds - 1 }],
  },
];

let origin;
let server;
let systemFailure;

function record(domain, operation, args, result) {
  calls.push({ domain, operation, args });
  if (result instanceof Error) return Promise.reject(result);
  return Promise.resolve(result);
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const systemService = {
  getSystemConfig: (...args) =>
    record(
      'system',
      'config',
      args,
      systemFailure || {
        id: 1,
        type: 'systemConfig',
        info: { timezone: 'Asia/Shanghai', cronConcurrency: 2 },
      },
    ),
  updateLogRemoveFrequency: (...args) =>
    record('system', 'log-remove-frequency', args, {
      code: 200,
      data: args[0],
    }),
  updateCronConcurrency: (...args) =>
    record('system', 'cron-concurrency', args, {
      code: 200,
      data: args[0],
    }),
  updateDependenceProxy: (...args) =>
    record('system', 'dependence-proxy', args, {
      code: 200,
      data: args[0],
    }),
  updatePythonMirror: (...args) =>
    record('system', 'python-mirror', args, {
      code: 200,
      data: args[0],
    }),
  checkUpdate: (...args) =>
    record('system', 'update-check', args, {
      code: 200,
      data: { hasNewVersion: false, lastVersion: '2.21.0' },
    }),
  updateSystem: (...args) => record('system', 'update', args, { code: 200 }),
  reloadSystem: (...args) => record('system', 'reload', args, { code: 200 }),
  notify: (...args) => record('system', 'notify', args, { code: 200 }),
};

const scriptService = {
  getFile: (...args) =>
    record('script', 'detail', args, `content:${args[0]}:${args[1]}`),
  checkFilePath(filePath, fileName) {
    calls.push({
      domain: 'script',
      operation: 'check-path',
      args: [filePath, fileName],
    });
    const resolved = path.resolve(config.scriptPath, filePath || '', fileName);
    const relative = path.relative(config.scriptPath, resolved);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? resolved
      : '';
  },
  runScript: (...args) =>
    record('script', 'run', args, { code: 200, data: 321 }),
  stopScript: (...args) => record('script', 'stop', args, { code: 200 }),
};

const openService = {
  list: (...args) =>
    record('open', 'list', args, [
      { id: 1, name: 'automation', scopes: ['scripts'], tokens: [] },
    ]),
  create: (...args) =>
    record('open', 'create', args, {
      id: 2,
      ...args[0],
      client_id: 'client-created',
      client_secret: 'secret-created',
      tokens: [],
    }),
  update: (...args) =>
    record('open', 'update', args, { ...args[0], tokens: [] }),
  remove: (...args) => record('open', 'remove', args, undefined),
  resetSecret: (...args) =>
    record('open', 'reset-secret', args, {
      id: args[0],
      client_secret: 'secret-reset',
      tokens: [],
    }),
  authToken: (...args) =>
    record('open', 'auth-token', args, {
      code: 200,
      data: {
        token: 'issued-open-token',
        token_type: 'Bearer',
        expiration: nowSeconds + 2_592_000,
      },
    }),
};

function authorization(token = panelToken) {
  return { authorization: `Bearer ${token}`, 'user-agent': 'desktop-test' };
}

async function request(method, pathname, options = {}) {
  const headers = { connection: 'close', ...(options.headers || {}) };
  let body;
  if (Object.hasOwn(options, 'body')) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed = text;
  if (
    (response.headers.get('content-type') || '').includes('application/json')
  ) {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function lastCall() {
  return calls.at(-1);
}

before(async () => {
  shareStore.getAuthInfo = async () => authInfo;
  shareStore.getApps = async () => apps;
  Container.set('logger', logger);
  Container.set(SystemService, systemService);
  Container.set(ScriptService, scriptService);
  Container.set(OpenService, openService);
  Container.set(UserService, {
    async getAuthInfo() {
      return authInfo;
    },
  });

  const app = express();
  expressLoader({ app });
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  server.unref();
  for (const token of [
    'logger',
    SystemService,
    ScriptService,
    OpenService,
    UserService,
  ]) {
    Container.remove(token);
  }
  delete require.cache[apiIndexModulePath];
  delete require.cache[sharedStoreModulePath];
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('preserves protected System contracts and validation ordering', async (t) => {
  const configResponse = await request('GET', '/api/system/config', {
    headers: authorization(),
  });
  assert.deepEqual(configResponse.body, {
    code: 200,
    data: {
      id: 1,
      type: 'systemConfig',
      info: { timezone: 'Asia/Shanghai', cronConcurrency: 2 },
    },
  });
  assert.deepEqual(lastCall(), {
    domain: 'system',
    operation: 'config',
    args: [],
  });

  for (const [pathName, operation, body] of [
    ['log-remove-frequency', 'log-remove-frequency', { logRemoveFrequency: 7 }],
    ['cron-concurrency', 'cron-concurrency', { cronConcurrency: 3 }],
    [
      'dependence-proxy',
      'dependence-proxy',
      { dependenceProxy: 'http://127.0.0.1:8080' },
    ],
    [
      'python-mirror',
      'python-mirror',
      { pythonMirror: 'https://pypi.example.invalid/simple' },
    ],
  ]) {
    await t.test(
      `${pathName} keeps the existing body and envelope`,
      async () => {
        const response = await request(
          'PUT',
          `/api/system/config/${pathName}`,
          { headers: authorization(), body },
        );
        assert.deepEqual(response, {
          status: 200,
          body: { code: 200, data: body },
          headers: response.headers,
        });
        assert.deepEqual(lastCall(), {
          domain: 'system',
          operation,
          args: [body],
        });
      },
    );
  }

  const reloaded = await request('PUT', '/api/system/reload', {
    headers: authorization(),
    body: { type: 'data' },
  });
  assert.deepEqual(reloaded.body, { code: 200 });
  assert.deepEqual(lastCall(), {
    domain: 'system',
    operation: 'reload',
    args: ['data'],
  });

  const notified = await request('PUT', '/api/system/notify', {
    headers: authorization(),
    body: { title: 'legacy', content: 'compatible' },
  });
  assert.deepEqual(notified.body, { code: 200 });
  assert.deepEqual(lastCall(), {
    domain: 'system',
    operation: 'notify',
    args: [{ title: 'legacy', content: 'compatible' }],
  });

  const callsBeforeInvalid = calls.length;
  const invalid = await request('PUT', '/api/system/notify', {
    headers: authorization(),
    body: { title: 'missing-content' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.statusCode, 400);
  assert.equal(invalid.body.error, 'Bad Request');
  assert.equal(calls.length, callsBeforeInvalid);
});

test('preserves Script file/run contracts while failing closed outside the script root', async (t) => {
  const listed = await request('GET', '/api/scripts', {
    headers: authorization(),
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.code, 200);
  assert.deepEqual(
    listed.body.data.map((entry) => [entry.title, entry.type, entry.key]),
    [
      ['jobs', 'directory', 'jobs'],
      ['existing.js', 'file', 'existing.js'],
    ],
  );

  const escaped = await request(
    'GET',
    '/api/scripts?path=..%2Fscripts-sibling',
    { headers: authorization() },
  );
  assert.deepEqual(escaped, {
    status: 200,
    body: { code: 200, data: [] },
    headers: escaped.headers,
  });

  const symlinkEscape = await request('GET', '/api/scripts?path=outside-link', {
    headers: authorization(),
  });
  assert.deepEqual(symlinkEscape, {
    status: 200,
    body: { code: 200, data: [] },
    headers: symlinkEscape.headers,
  });

  const detail = await request(
    'GET',
    '/api/scripts/detail?path=jobs&file=task.js',
    { headers: authorization() },
  );
  assert.deepEqual(detail.body, { code: 200, data: 'content:jobs:task.js' });
  assert.deepEqual(lastCall(), {
    domain: 'script',
    operation: 'detail',
    args: ['jobs', 'task.js'],
  });

  const created = await request('POST', '/api/scripts', {
    headers: authorization(),
    body: { filename: 'created.js', content: 'created\n' },
  });
  assert.deepEqual(created.body, { code: 200 });
  assert.equal(
    fs.readFileSync(path.join(config.scriptPath, 'created.js'), 'utf8'),
    'created\n',
  );

  const renamed = await request('PUT', '/api/scripts/rename', {
    headers: authorization(),
    body: {
      filename: 'created.js',
      path: '',
      newFilename: 'renamed.js',
    },
  });
  assert.deepEqual(renamed.body, { code: 200 });
  assert.equal(
    fs.existsSync(path.join(config.scriptPath, 'created.js')),
    false,
  );
  assert.equal(fs.existsSync(path.join(config.scriptPath, 'renamed.js')), true);

  const run = await request('PUT', '/api/scripts/run', {
    headers: authorization(),
    body: { filename: 'task.js', path: 'jobs', content: 'run\n' },
  });
  assert.deepEqual(run.body, { code: 200, data: 321 });
  assert.equal(lastCall().domain, 'script');
  assert.equal(lastCall().operation, 'run');
  assert.equal(
    lastCall().args[0],
    path.join(config.scriptPath, 'jobs', 'task.swap.js'),
  );

  const callsBeforeEscape = calls.length;
  const rejectedRun = await request('PUT', '/api/scripts/run', {
    headers: authorization(),
    body: {
      filename: 'outside.js',
      path: '../scripts-sibling',
      content: 'forbidden\n',
    },
  });
  assert.deepEqual(rejectedRun.body, { code: 403, message: '暂无权限' });
  assert.equal(calls.length, callsBeforeEscape);

  await t.test(
    'invalid run body is rejected before ScriptService',
    async () => {
      const callCount = calls.length;
      const invalid = await request('PUT', '/api/scripts/run', {
        headers: authorization(),
        body: { content: 'missing filename' },
      });
      assert.equal(invalid.status, 400);
      assert.equal(calls.length, callCount);
    },
  );
});

test('preserves Open app management and token issuance envelopes', async () => {
  const listed = await request('GET', '/api/apps', {
    headers: authorization(),
  });
  assert.deepEqual(listed.body, {
    code: 200,
    data: [{ id: 1, name: 'automation', scopes: ['scripts'], tokens: [] }],
  });
  assert.deepEqual(lastCall(), { domain: 'open', operation: 'list', args: [] });

  const createBody = { name: 'automation-2', scopes: ['scripts', 'system'] };
  const created = await request('POST', '/api/apps', {
    headers: authorization(),
    body: createBody,
  });
  assert.equal(created.body.code, 200);
  assert.deepEqual(created.body.data, {
    id: 2,
    ...createBody,
    client_id: 'client-created',
    client_secret: 'secret-created',
    tokens: [],
  });
  assert.deepEqual(lastCall(), {
    domain: 'open',
    operation: 'create',
    args: [createBody],
  });

  const updateBody = { id: 2, name: 'renamed', scopes: ['system'] };
  const updated = await request('PUT', '/api/apps', {
    headers: authorization(),
    body: updateBody,
  });
  assert.deepEqual(updated.body, {
    code: 200,
    data: { ...updateBody, tokens: [] },
  });

  const removed = await request('DELETE', '/api/apps', {
    headers: authorization(),
    body: [2],
  });
  assert.deepEqual(removed.body, { code: 200 });
  assert.deepEqual(lastCall(), {
    domain: 'open',
    operation: 'remove',
    args: [[2]],
  });

  const reset = await request('PUT', '/api/apps/2/reset-secret', {
    headers: authorization(),
  });
  assert.deepEqual(reset.body, {
    code: 200,
    data: { id: 2, client_secret: 'secret-reset', tokens: [] },
  });
  assert.deepEqual(lastCall(), {
    domain: 'open',
    operation: 'reset-secret',
    args: [2],
  });

  const issued = await request(
    'GET',
    '/open/auth/token?client_id=client&client_secret=secret',
  );
  assert.deepEqual(issued.body, {
    code: 200,
    data: {
      token: 'issued-open-token',
      token_type: 'Bearer',
      expiration: nowSeconds + 2_592_000,
    },
  });
  assert.deepEqual(
    {
      ...lastCall(),
      args: lastCall().args.map((argument) => ({ ...argument })),
    },
    {
      domain: 'open',
      operation: 'auth-token',
      args: [{ client_id: 'client', client_secret: 'secret' }],
    },
  );
});

test('locks panel/Open authentication, scope and error envelopes', async () => {
  const missing = await request('GET', '/api/system/config');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 401);

  const foreign = await request('GET', '/api/system/config', {
    headers: authorization(foreignPanelToken),
  });
  assert.deepEqual(foreign, {
    status: 401,
    body: { code: 401, message: 'Token 已失效' },
    headers: foreign.headers,
  });

  const scoped = await request(
    'GET',
    '/open/scripts/detail?path=jobs&file=open.js',
    { headers: authorization('open-script-token') },
  );
  assert.deepEqual(scoped.body, {
    code: 200,
    data: 'content:jobs:open.js',
  });

  const denied = await request(
    'GET',
    '/open/scripts/detail?path=jobs&file=denied.js',
    { headers: authorization('open-system-token') },
  );
  assert.deepEqual(denied, {
    status: 401,
    body: { code: 401, message: '暂无权限' },
    headers: denied.headers,
  });

  const expired = await request(
    'GET',
    '/open/scripts/detail?path=jobs&file=expired.js',
    { headers: authorization('expired-open-token') },
  );
  assert.deepEqual(expired, {
    status: 401,
    body: { code: 401, message: 'Token 已失效' },
    headers: expired.headers,
  });

  const caseVariant = await request('GET', '/API/system');
  assert.deepEqual(caseVariant, {
    status: 400,
    body: { code: 400, message: 'Invalid path format' },
    headers: caseVariant.headers,
  });

  systemFailure = new Error('legacy-system-failed');
  const failed = await request('GET', '/api/system/config', {
    headers: authorization(),
  });
  systemFailure = undefined;
  assert.deepEqual(failed, {
    status: 500,
    body: { code: 500, message: 'legacy-system-failed' },
    headers: failed.headers,
  });
});

test('uses separator-aware Script path containment across API and service boundaries', () => {
  const inside = path.join(config.scriptPath, 'jobs', 'task.js');
  const sibling = path.resolve(
    config.scriptPath,
    '..',
    'scripts-sibling',
    'task.js',
  );
  assert.equal(isPathInside(config.scriptPath, config.scriptPath), true);
  assert.equal(isPathInside(config.scriptPath, inside), true);
  assert.equal(isPathInside(config.scriptPath, sibling), false);
  assert.equal(
    ScriptService.prototype.checkFilePath.call({}, 'jobs', 'task.js'),
    inside,
  );
  assert.equal(
    ScriptService.prototype.checkFilePath.call(
      {},
      '../scripts-sibling',
      'task.js',
    ),
    '',
  );
});
