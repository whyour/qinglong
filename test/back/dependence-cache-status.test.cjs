const assert = require('node:assert/strict');
const test = require('node:test');

test('dependency listing marks cache entries missing from disk for reinstall', async (t) => {
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

  const DependenceStatus = {
    installing: 0,
    installed: 1,
    installFailed: 2,
  };
  const DependenceTypes = { nodejs: 0, python3: 1, linux: 2 };
  const docs = [
    { id: 1, name: 'missing-package', type: 0, status: 1 },
    { id: 2, name: 'present-package', type: 0, status: 1 },
  ];
  const updates = [];
  const DependenceModel = {
    findAll: async ({ where }) => {
      if (where.status === DependenceStatus.installed) {
        return docs;
      }
      return docs.map((doc) => ({
        ...doc,
        status: updates.some((update) => update.ids.includes(doc.id))
          ? DependenceStatus.installFailed
          : doc.status,
      }));
    },
    update: async ({ status }, { where }) => {
      updates.push({ status, ids: where.id });
    },
  };

  stubModule('../../back/config', {
    __esModule: true,
    default: {},
  });
  stubModule('../../back/data/dependence', {
    Dependence: class Dependence {},
    DependenceModel,
    DependenceStatus,
    DependenceTypes,
    versionDependenceCommandTypes: { 0: '@', 1: '==', 2: '=' },
  });
  stubModule('../../back/config/util', {
    concurrentRun: async (tasks) => Promise.all(tasks.map((task) => task())),
    detectOS: async () => 'Alpine',
    fileExist: async () => false,
    getGetCommand: (_type, name) => `check:${name}`,
    getInstallCommand: () => '',
    getPid: async () => 0,
    getUninstallCommand: () => '',
    killTask: async () => {},
    promiseExecSuccess: async (command) =>
      command === 'check:present-package' ? 'present-package 1.0.0\n' : '',
  });
  stubModule('../../back/config/const', {
    LINUX_DEPENDENCE_COMMAND: { Alpine: {} },
  });
  stubModule('../../back/shared/pLimit', {
    __esModule: true,
    default: {},
  });
  stubModule('../../back/shared/i18n', {
    t: (message) => message,
    tf: (message) => message,
  });
  stubModule('../../back/services/sock', {
    __esModule: true,
    default: class SockService {},
  });

  const servicePath = require.resolve('../../back/services/dependence');
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

  const DependenceService = require('../../back/services/dependence').default;
  const service = new DependenceService({}, {});
  const result = await service.dependencies({
    searchValue: '',
    type: 'nodejs',
    status: '',
  });

  assert.deepEqual(updates, [
    { status: DependenceStatus.installFailed, ids: [1] },
  ]);
  assert.deepEqual(
    result.map(({ id, status }) => ({ id, status })),
    [
      { id: 1, status: DependenceStatus.installFailed },
      { id: 2, status: DependenceStatus.installed },
    ],
  );

  await service.dependencies({ searchValue: '', type: 'linux', status: '' });
  assert.equal(updates.length, 1);
});
