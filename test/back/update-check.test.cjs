const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');
const yaml = require('js-yaml');
function service(request) {
  const Service = load('back/services/system.ts', {
    undici: { request },
    '../config': {
      versionFile: 'version.yaml',
      lastVersionFile: 'https://version.example/version.yaml',
    },
    '../config/const': {},
    '../config/util': {
      parseVersion: async () => ({ version: '2.23.0' }),
      parseContentVersion: yaml.load,
    },
    '../data/dependence': {},
    '../data/notify': {},
    '../data/system': {},
    '../shared/pLimit': {},
    '../schedule/client': {},
    '../shared/i18n': { t: (key) => key },
    './notify': class {},
    './schedule': class {},
    './sock': class {},
  }).default;
  return new Service({}, {}, {});
}
for (const [name, request] of [
  [
    'unreachable server',
    async () => {
      throw new Error('network down');
    },
  ],
  [
    'HTTP error with a version-like body',
    async () => ({
      statusCode: 503,
      body: { text: async () => 'version: 2.23.0' },
    }),
  ],
  [
    'HTML response',
    async () => ({
      statusCode: 200,
      body: { text: async () => '<html>gateway error</html>' },
    }),
  ],
  [
    'invalid version',
    async () => ({
      statusCode: 200,
      body: { text: async () => 'version: latest' },
    }),
  ],
  [
    'unreadable body',
    async () => ({
      statusCode: 200,
      body: {
        text: async () => {
          throw new Error('reset');
        },
      },
    }),
  ],
])
  test(`update check reports failure for ${name}, without claiming the latest version`, async () => {
    assert.deepEqual(await service(request).checkUpdate(), {
      code: 400,
      message: '检查更新失败，请检查网络后重试',
    });
  });
for (const [version, newer] of [
  ['2.23.0', false],
  ['2.23.1', true],
  ['2.22.0', false],
  ['3.0.0', true],
])
  test(`valid update response ${version}`, async () => {
    const result = await service(async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return {
        statusCode: 200,
        body: {
          text: async () => `version: ${version}\nchangeLog: release notes`,
        },
      };
    }).checkUpdate();
    assert.equal(result.code, 200);
    assert.equal(result.data.hasNewVersion, newer);
    assert.equal(result.data.lastVersion, version);
    assert.equal(result.data.lastLog, 'release notes');
  });
test('a stalled version request times out instead of hanging the update check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checking = service(async (url, { signal }) => {
    return new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      }),
    );
  }).checkUpdate();
  await Promise.resolve();
  t.mock.timers.tick(15000);
  assert.equal((await checking).code, 400);
});
