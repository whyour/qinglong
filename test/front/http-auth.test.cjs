const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const axios = require('axios');

function fixture(pathname = '/login', baseUrl = '/') {
  const storage = new Map([['token', 'expired-token']]);
  const pushes = [];
  const history = { location: { pathname }, push: (p) => pushes.push(p) };
  const config = { authKey: 'token', baseUrl };
  const mocks = {
    axios,
    'react-intl-universal': { get: (s) => s },
    antd: {
      message: { config() {}, error() {} },
      notification: { error() {} },
    },
    './config': config,
    '@umijs/max': { history },
    './httpError': { getErrorDetails: () => [] },
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/utils/http.tsx'),
    'utf8',
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', outputText)(
    (name) => {
      assert.ok(Object.hasOwn(mocks, name), name);
      return mocks[name];
    },
    module,
    module.exports,
    {
      getItem: (k) => storage.get(k) ?? null,
      removeItem: (k) => storage.delete(k),
    },
  );
  return { request: module.exports.request, storage, pushes };
}

for (const pathname of ['/login', '/dashboard']) {
  test(`401 clears expired credentials on ${pathname}`, async () => {
    const { request, storage, pushes } = fixture(pathname);
    await assert.rejects(
      request.get('/api/user', {
        adapter: async (config) => {
          throw new axios.AxiosError(
            'Unauthorized',
            'ERR_BAD_REQUEST',
            config,
            null,
            { status: 401, data: { message: 'expired' }, config },
          );
        },
      }),
    );
    assert.equal(storage.has('token'), false);
    assert.deepEqual(pushes, pathname === '/login' ? [] : ['/login']);
  });
}
for (const baseUrl of ['/', '/panel/']) {
  test(`health is anonymous while protected requests keep credentials (${baseUrl})`, async () => {
    const { request } = fixture('/login', baseUrl);
    const headers = [];
    const adapter = async (config) => {
      headers.push(config.headers.get('Authorization'));
      return { status: 200, data: { code: 200 }, config };
    };
    await request.get(`${baseUrl}api/health`, { adapter });
    await request.get(`${baseUrl}api/user`, { adapter });
    assert.deepEqual(headers, [undefined, 'Bearer expired-token']);
  });
}

function healthFixture(get) {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/layouts/index.tsx'),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'index.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let initializer;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === 'getHealthStatus'
    )
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, 'layout health bootstrap exists');
  const { outputText } = ts.transpileModule(
    `const bootstrap = ${initializer.getText(ast)};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    },
  );
  const events = [];
  const bootstrap = new Function(
    'request',
    'config',
    'history',
    'window',
    'getSystemInfo',
    'setInitLoading',
    `${outputText}; return bootstrap;`,
  )(
    { get },
    { apiPrefix: '/api/' },
    { push: (p) => events.push(p) },
    { location: { reload: () => events.push('reload') } },
    () => events.push('system'),
    (value) => events.push(['loading', value]),
  );
  return { bootstrap, events };
}
for (const status of [401, 503, undefined]) {
  test(`health failure ${
    status ?? 'network'
  } settles without reloading`, async () => {
    const { bootstrap, events } = healthFixture(async () => {
      throw status ? { response: { status } } : new Error('Network Error');
    });
    bootstrap();
    await new Promise(setImmediate);
    assert.deepEqual(events, ['/error', ['loading', false]]);
  });
}
test('healthy bootstrap continues loading system information', async () => {
  const { bootstrap, events } = healthFixture(async () => ({
    data: { status: 'ok' },
  }));
  bootstrap();
  await new Promise(setImmediate);
  assert.deepEqual(events, ['system', ['loading', false]]);
});
