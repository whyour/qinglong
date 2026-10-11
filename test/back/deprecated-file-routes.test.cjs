const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

function mockModule(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

mockModule('../../back/config', {
  __esModule: true,
  default: {
    bakPath: '/tmp',
    blackFileList: [],
    configPath: '/tmp',
    logPath: '/tmp',
    logs: { level: 'info' },
    rootPath: '/tmp',
    scriptPath: '/tmp',
    systemLogPath: '/tmp',
    writePathList: ['/tmp'],
  },
});
mockModule('../../back/shared/i18n', {
  t: (message) => message,
});
mockModule('../../back/config/util', {
  fileExist: async () => false,
  readDir: async () => [],
  readDirs: async () => [],
  removeAnsi: (content) => content,
  rmPath: async () => {},
});
mockModule('../../back/shared/utils', {
  writeFileWithLock: async () => {},
});
for (const service of ['config', 'script', 'log']) {
  mockModule(`../../back/services/${service}`, {
    __esModule: true,
    default: class {},
  });
}
mockModule('../../back/data/runningInstance', {
  InstanceStatus: { running: 'running' },
  RunningInstanceModel: { findOne: async () => null },
});

const deprecatedRoutes = [
  ['config', '/configs/detail'],
  ['script', '/scripts/detail'],
  ['log', '/logs/detail'],
];

for (const [moduleName, replacement] of deprecatedRoutes) {
  test(`${moduleName} filename route points callers to its detail API`, () => {
    const app = express.Router();
    require(`../../back/api/${moduleName}`).default(app);
    const router = app.stack.find((layer) => layer.name === 'router').handle;
    const deprecatedRoute = router.stack.find(
      (layer) => layer.route?.path === '/:file',
    );
    const handler = deprecatedRoute.route.stack.at(-1).handle;
    let responseBody;

    handler(
      { params: { file: 'Example.js' }, query: {} },
      { send: (body) => (responseBody = body) },
    );

    assert.deepEqual(responseBody, {
      code: 410,
      message: `接口已下线，请使用 ${replacement} 接口`,
    });
  });
}
