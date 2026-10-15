const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

const types = { nodejs: 0, python3: 1, linux: 2 };
const statuses = { installed: 1, installFailed: 2, queued: 6, cancelled: 7 };
const util = load('back/config/util.ts', {
  './index': {},
  './const': {},
  '../loaders/logger': {},
  '../shared/utils': {},
  '../data/dependence': { DependenceTypes: types },
});

function serviceFor(docs) {
  const probes = [],
    removed = [],
    uninstalls = [];
  const Service = load('back/services/dependence.ts', {
    '../config': {},
    '../data/dependence': {
      Dependence: class {},
      DependenceTypes: types,
      DependenceStatus: statuses,
      versionDependenceCommandTypes: { 0: '@', 1: '==', 2: '=' },
      DependenceModel: {
        findAll: async ({ where }) =>
          docs.filter(
            (d) =>
              (where.status === undefined || d.status === where.status) &&
              (!where.id || where.id.includes(d.id)),
          ),
        update: async (values, { where }) => {
          docs
            .filter((d) => where.id.includes(d.id))
            .forEach((d) => Object.assign(d, values));
        },
        destroy: async ({ where }) => removed.push(...where.id),
      },
    },
    '../config/util': {
      ...util,
      concurrentRun: (tasks) => Promise.all(tasks.map((fn) => fn())),
      getGetCommand: (type, name) => {
        probes.push(name);
        return util.getGetCommand(type, name);
      },
      promiseExecSuccess: async () => '',
    },
    '../shared/pLimit': { removeQueuedDependency() {} },
    './sock': class {},
    '../shared/i18n': {},
  }).default;
  const service = new Service({}, {});
  service.installDependenceOneByOne = (dependencies, install, force) => {
    uninstalls.push({ ids: dependencies.map((d) => d.id), install, force });
    return Promise.resolve();
  };
  return { service, probes, removed, uninstalls };
}

test('listing preserves Python source results and still detects missing named packages', async () => {
  const docs = [
    ' requirements with spaces/requirements.txt ',
    'requirements-dev.in',
    'project/pyproject.toml',
    'git+https://example.invalid/repo.git',
    'https://example.invalid/pkg.whl',
    'missing-package',
  ].map((name, i) => ({ id: i + 1, name, type: 1, status: 1 }));
  const { service, probes } = serviceFor(docs);
  for (let i = 0; i < 2; i++) {
    await service.dependencies({
      searchValue: '',
      type: 'python3',
      status: '',
    });
  }
  assert.deepEqual(
    docs.map((d) => d.status),
    [1, 1, 1, 1, 1, 2],
  );
  assert.deepEqual(probes, ['missing-package']);
  // Source installs must continue to execute pip rather than treating the source as a package name.
  assert.equal(util.getGetCommand(1, docs[0].name), 'echo ""');
});

test('deletion cleans previously misclassified Python sources and only queues intended records', async () => {
  const docs = [
    { id: 1, name: 'requirements.txt', type: 1, status: 2 },
    { id: 2, name: 'present-package', type: 0, status: 1 },
    { id: 3, name: 'missing-package', type: 0, status: 2 },
    { id: 4, name: 'queued/requirements.txt', type: 1, status: 6 },
    { id: 5, name: 'cancelled/requirements.txt', type: 1, status: 7 },
    { id: 6, name: 'git+https://example.invalid/repo.git', type: 1, status: 2 },
  ];
  const { service, removed, uninstalls } = serviceFor(docs);
  await service.remove(docs.map((d) => d.id));
  assert.deepEqual(removed, [3, 4, 5]);
  assert.deepEqual(uninstalls, [
    { ids: [1, 2, 6], install: false, force: false },
  ]);
  assert.equal(docs[2].status, 2);
});

test('Alpine container mirror command runs without sudo and writes valid repositories', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-alpine-mirror-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source =
    'https://dl-cdn.alpinelinux.org/alpine/v3.23/main\nhttps://dl-cdn.alpinelinux.org/alpine/v3.23/community\n';
  const api = load('back/config/util.ts', {
    'fs/promises': { readFile: async () => source },
    './index': {},
    './const': {},
    './share': {},
    './container': { isInContainer: () => true },
    '../loaders/logger': {},
    '../shared/utils': {},
    '../shared/fileAccess': {},
    '../data/dependence': {},
  });
  const previous = process.env.QL_OS_TYPE;
  let command;
  try {
    process.env.QL_OS_TYPE = 'alpine';
    command = await api.updateLinuxMirrorFile('https://mirror.example/alpine');
  } finally {
    if (previous === undefined) delete process.env.QL_OS_TYPE;
    else process.env.QL_OS_TYPE = previous;
  }
  // Redirect the generated command's paths and executable into the fixture only.
  const file = path.join(root, 'repositories');
  const update = path.join(root, 'updated');
  const sandbox = command
    .replaceAll('/etc/apk/repositories', file)
    .replaceAll('/etc/apk', root);
  execFileSync('/bin/bash', [
    '-c',
    `sudo(){ return 127; }; apk(){ test "$1" = update && touch '${update}'; }; ${sandbox}`,
  ]);
  assert.ok(fs.existsSync(update));
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    source.replaceAll(
      'https://dl-cdn.alpinelinux.org/alpine',
      'https://mirror.example/alpine',
    ),
  );
});

test('force deletion removes a source record even when its requirements file is gone', async () => {
  const removed = [],
    updates = [];
  const Service = load('back/services/dependence.ts', {
    '../config': {},
    '../config/util': {
      getUninstallCommand() {
        throw Error('Python dependency file must be inside scripts or repo');
      },
    },
    '../data/dependence': {
      Dependence: class {},
      DependenceTypes: types,
      DependenceStatus: { ...statuses, removeFailed: 5 },
      DependenceModel: {
        destroy: async ({ where }) => removed.push(...where.id),
        update: async (values) => updates.push(values),
      },
    },
    '../shared/pLimit': {
      runDependeny: (_dep, fn) => fn(),
      removeQueuedDependency() {},
    },
    './sock': class {},
    '../shared/i18n': {},
  }).default;
  const service = new Service({}, {});
  const dep = { id: 1, name: 'gone/requirements.txt', type: 1, status: 2 };
  await service.installOrUninstallDependency(dep, false, false);
  assert.deepEqual(removed, []);
  assert.equal(updates[0].status, 5);
  await service.installOrUninstallDependency(dep, false, true);
  assert.deepEqual(removed, [1]);
});

test('Python extras run pip even when the base package version is already installed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-extra-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'pip-ran');
  const dep = {
    id: 1,
    name: 'fixture[optional]>=1',
    type: 1,
    status: 6,
    log: [],
  };
  let probes = 0;
  const Service = load('back/services/dependence.ts', {
    '../config': {},
    '../config/util': {
      getInstallCommand: () => `printf installed > '${marker}'`,
      getGetCommand: () => {
        probes++;
        return 'probe';
      },
      promiseExecSuccess: async () => '1.0',
      detectOS: async () => 'Alpine',
      fileExist: async () => false,
    },
    '../data/dependence': {
      Dependence: class {},
      DependenceTypes: types,
      DependenceStatus: { ...statuses, installing: 0, cancelled: 7 },
      versionDependenceCommandTypes: { 0: '@', 1: '==', 2: '=' },
      DependenceModel: {
        findAll: async () => [dep],
        update: async (values) => Object.assign(dep, values),
      },
    },
    '../shared/pLimit': {
      firstDependencyId: 1,
      runDependeny: (_dep, fn) => fn(),
      removeQueuedDependency() {},
      updateDepLog: (fn) => fn(),
    },
    './sock': class {},
    '../shared/i18n': { t: (text) => text, tf: (text) => text },
  }).default;
  const service = new Service({}, { sendMessage() {} });
  await service.installOrUninstallDependency(dep, true, false);
  assert.equal(probes, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'installed');
  assert.equal(dep.status, 1);
});
