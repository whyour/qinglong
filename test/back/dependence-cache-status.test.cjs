const assert = require('node:assert/strict');
const test = require('node:test');

test('dependency listing uses stored status until explicitly refreshed', async (t) => {
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
    {
      id: 1,
      name: 'missing-package',
      type: 0,
      status: 1,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 2,
      name: 'present-package',
      type: 0,
      status: 1,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];
  const updates = [];
  const probes = [];
  const DependenceModel = {
    findAll: async ({ where }) => {
      if (where.status === DependenceStatus.installed) {
        return docs
          .filter((doc) => doc.status === DependenceStatus.installed)
          .map((doc) => ({ ...doc }));
      }
      return docs.map((doc) => ({ ...doc }));
    },
    update: async ({ status }, { where }) => {
      const changed = docs.filter(
        (doc) =>
          doc.id === where.id &&
          doc.status === where.status &&
          doc.name === where.name &&
          doc.type === where.type &&
          doc.updatedAt.getTime() === where.updatedAt.getTime(),
      );
      for (const doc of changed) {
        doc.status = status;
        doc.updatedAt = new Date(doc.updatedAt.getTime() + 1000);
      }
      if (changed.length)
        updates.push({ status, ids: changed.map((d) => d.id) });
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
    isPythonSourceDependency: () => false,
    getPid: async () => 0,
    getUninstallCommand: () => '',
    killTask: async () => {},
    promiseExecSuccess: async (command) => {
      probes.push(command);
      return command === 'check:present-package'
        ? 'present-package 1.0.0\n'
        : '';
    },
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
  const query = {
    searchValue: '',
    type: 'nodejs',
    status: '',
  };
  const cached = await service.dependencies(query);
  assert.deepEqual(updates, []);
  assert.deepEqual(probes, []);
  assert.deepEqual(
    cached.map(({ status }) => status),
    [1, 1],
  );

  const { job } = service.startRefresh('nodejs');
  assert.equal(job.state, 'running');
  await new Promise(setImmediate);
  assert.equal(service.getRefreshJob(job.id).state, 'completed');
  const result = await service.dependencies(query);

  assert.deepEqual(updates, [
    { status: DependenceStatus.installFailed, ids: [1] },
  ]);
  assert.deepEqual(probes, ['check:missing-package', 'check:present-package']);
  assert.deepEqual(
    result.map(({ id, status }) => ({ id, status })),
    [
      { id: 1, status: DependenceStatus.installFailed },
      { id: 2, status: DependenceStatus.installed },
    ],
  );

  await service.dependencies({ searchValue: '', type: 'linux', status: '' });
  assert.equal(updates.length, 1);
  assert.equal(probes.length, 2);

  let finishProbe;
  service.isDependenceInstalled = async () => {
    await new Promise((resolve) => {
      finishProbe = resolve;
    });
    return false;
  };
  const racing = service.startRefresh('nodejs');
  await new Promise(setImmediate);
  docs[1].updatedAt = new Date(docs[1].updatedAt.getTime() + 1000);
  finishProbe();
  await new Promise(setImmediate);
  assert.equal(racing.job.state, 'completed');
  assert.equal(docs[1].status, DependenceStatus.installed);
  assert.equal(updates.length, 1);

  let finishRefresh;
  service.refreshInstalledStatuses = () =>
    new Promise((resolve) => {
      finishRefresh = resolve;
    });
  const first = service.startRefresh('nodejs');
  assert.equal(first.accepted, true);
  assert.equal(service.getActiveRefreshJob().id, first.job.id);
  assert.equal(service.startRefresh('nodejs').job.id, first.job.id);
  assert.equal(service.startRefresh('python3').accepted, false);
  finishRefresh();
  await new Promise(setImmediate);
  assert.equal(first.job.state, 'completed');
  assert.equal(service.getActiveRefreshJob(), undefined);
  const second = service.startRefresh('python3');
  assert.equal(second.accepted, true);
  finishRefresh();
  await new Promise(setImmediate);
  assert.equal(second.job.state, 'completed');
});
