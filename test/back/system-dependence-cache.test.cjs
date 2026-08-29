const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('clearing a dependency cache marks installed entries for reinstall', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-dependence-'));
  const nodeCache = path.join(directory, 'node');
  await fs.mkdir(nodeCache);
  await fs.writeFile(path.join(nodeCache, 'package'), 'cached');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const moduleStubs = new Map();
  const stubModule = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    moduleStubs.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
      children: [],
      paths: [],
    };
  };
  const updates = [];
  const DependenceStatus = { installed: 1, installFailed: 2 };
  const DependenceTypes = { nodejs: 0, python3: 1 };

  stubModule('../../back/config', {
    __esModule: true,
    default: { dependenceCachePath: directory },
  });
  stubModule('../../back/config/const', {
    NotificationModeStringMap: {},
    TASK_COMMAND: 'task',
  });
  stubModule('../../back/config/util', {
    getPid: async () => 0,
    killTask: async () => {},
    parseContentVersion: () => '',
    parseVersion: () => '',
    promiseExec: async () => '',
    readDirs: async () => [],
    rmPath: async () => {},
    setSystemTimezone: async () => true,
    updateLinuxMirrorFile: async () => {},
  });
  stubModule('../../back/data/dependence', {
    DependenceModel: {
      update: async (values, options) => updates.push({ values, options }),
    },
    DependenceStatus,
    DependenceTypes,
  });
  stubModule('../../back/data/notify', {});
  stubModule('../../back/data/system', {
    AuthDataType: {},
    SystemModel: {},
  });
  stubModule('../../back/shared/pLimit', {
    __esModule: true,
    default: {},
  });
  stubModule('../../back/shared/i18n', {
    setLang: () => {},
    t: (message) => message,
  });
  stubModule('../../back/services/notify', {
    __esModule: true,
    default: class NotificationService {},
  });
  stubModule('../../back/services/schedule', {
    __esModule: true,
    default: class ScheduleService {},
  });
  stubModule('../../back/services/sock', {
    __esModule: true,
    default: class SockService {},
  });

  const servicePath = require.resolve('../../back/services/system');
  const originalService = require.cache[servicePath];
  delete require.cache[servicePath];
  t.after(() => {
    if (originalService) {
      require.cache[servicePath] = originalService;
    } else {
      delete require.cache[servicePath];
    }
    for (const [resolved, original] of moduleStubs) {
      if (original) {
        require.cache[resolved] = original;
      } else {
        delete require.cache[resolved];
      }
    }
  });

  const SystemService = require('../../back/services/system').default;
  const service = new SystemService({}, {}, {});
  assert.deepEqual(await service.cleanDependence('node'), { code: 200 });
  assert.deepEqual(await service.cleanDependence('python3'), { code: 200 });
  await assert.rejects(fs.stat(nodeCache), { code: 'ENOENT' });
  assert.deepEqual(updates, [
    {
      values: { status: DependenceStatus.installFailed },
      options: {
        where: {
          type: DependenceTypes.nodejs,
          status: DependenceStatus.installed,
        },
      },
    },
    {
      values: { status: DependenceStatus.installFailed },
      options: {
        where: {
          type: DependenceTypes.python3,
          status: DependenceStatus.installed,
        },
      },
    },
  ]);
});
