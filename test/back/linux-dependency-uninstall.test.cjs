const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const load = require('../helpers/load-security-module.cjs');

const types = { nodejs: 0, python3: 1, linux: 2 };
const util = load('back/config/util.ts', {
  './index': {},
  './const': {},
  '../loaders/logger': {},
  '../shared/utils': {},
  '../data/dependence': { DependenceTypes: types },
});

for (const specifier of [
  'tree', ' tree=2.3.2-r0 ', 'tree>=2.3', 'tree<=2.3', 'tree~2.3',
  'tree>2', 'tree<3', 'tree@testing', 'tree@testing=2.3.2-r0',
]) {
  test(`apk uninstall removes the constraint from ${specifier}`, () => {
    assert.equal(util.getUninstallCommand(2, specifier, 'Alpine'), 'apk del -- tree');
  });
}

for (const osType of ['Debian', 'Ubuntu']) {
  for (const specifier of ['tree', 'tree=2.1.0-1', 'tree:amd64=1:2.1.0-1+b1', 'tree/stable']) {
    test(`${osType} uninstall preserves ${specifier}, including sudo selection`, (t) => {
      const original = process.env.QL_CONTAINER;
      t.after(() => {
        if (original === undefined) delete process.env.QL_CONTAINER;
        else process.env.QL_CONTAINER = original;
      });
      for (const container of ['false', 'true']) {
        process.env.QL_CONTAINER = container;
        assert.equal(util.getUninstallCommand(2, specifier, osType),
          `${container === 'true' ? 'sudo ' : ''}apt-get remove -y ${specifier}`);
      }
    });
  }
}

test('standalone Linux uninstall uses the detected OS when no override is supplied', (t) => {
  const original = process.env.QL_OS_TYPE;
  t.after(() => {
    if (original === undefined) delete process.env.QL_OS_TYPE;
    else process.env.QL_OS_TYPE = original;
  });
  process.env.QL_OS_TYPE = 'Alpine';
  assert.equal(util.getUninstallCommand(2, 'tree=2.3.2-r0'), 'apk del -- tree');
});

for (const osType of ['Alpine', 'Debian', 'Ubuntu']) {
  for (const specifier of ['tree', 'tree=2.3.2-r0']) {
    test(`${osType} service installs, uninstalls and cancels ${specifier} consistently`, async (t) => {
      const original = process.env.QL_CONTAINER;
      process.env.QL_CONTAINER = 'false';
      t.after(() => {
        if (original === undefined) delete process.env.QL_CONTAINER;
        else process.env.QL_CONTAINER = original;
      });
      const install = `${osType === 'Alpine' ? 'apk add --no-check-certificate' : 'apt-get install -y'} ${specifier}`;
      const uninstall = osType === 'Alpine' ? 'apk del -- tree' : `apt-get remove -y ${specifier}`;
      const spawned = [], lookedUp = [], killed = [], removed = [];
      const dep = { id: 1, name: specifier, type: 2, status: 1, log: [] };
      const Service = load('back/services/dependence.ts', {
        '../config': {},
        '../config/util': {
          ...util,
          detectOS: async () => osType,
          fileExist: async () => false,
          getPid: async (command) => {
            lookedUp.push(command);
            return command === uninstall ? 77 : undefined;
          },
          killTask: async (pid) => killed.push(pid),
        },
        '../data/dependence': {
          Dependence: class {},
          DependenceTypes: types,
          DependenceStatus: { installed: 1, installing: 0, removing: 3, removed: 4, removeFailed: 5, cancelled: 7 },
          versionDependenceCommandTypes: { 0: '@', 1: '==', 2: '=' },
          DependenceModel: {
            findAll: async () => [dep],
            update: async (values) => Object.assign(dep, values),
            destroy: async ({ where }) => removed.push(...where.id),
          },
        },
        '../shared/pLimit': {
          firstDependencyId: 1,
          runDependeny: (_dep, fn) => fn(),
          removeQueuedDependency() {},
          updateDepLog: (fn) => fn(),
        },
        'cross-spawn': {
          spawn: (command) => {
            spawned.push(command.trim());
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => child.emit('exit', 0));
            return child;
          },
        },
        './sock': class {},
        '../shared/i18n': { t: (text) => text, tf: (text) => text },
      }).default;
      const service = new Service({}, { sendMessage() {} });
      await service.cancel([1]);
      assert.deepEqual(lookedUp, [install, uninstall]);
      assert.deepEqual(killed, [77]);
      await service.installOrUninstallDependency(dep, true, true);
      assert.equal(dep.status, 1);
      await service.installOrUninstallDependency(dep, false);
      assert.deepEqual(spawned, [install, uninstall]);
      assert.deepEqual(removed, [1]);
    });
  }
}
