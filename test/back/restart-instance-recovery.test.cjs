const { DatabaseClient } = require('../../back/data/databaseClient');
const { repository, initialize } = require('../helpers/repository-fixture.cjs');
const { orderBy } = require('../../back/data/queries');
const assert = require('node:assert/strict');
const test = require('node:test');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
test('startup closes interrupted instances without inventing exit codes or rewriting history', async (t) => {
  const db = new DatabaseClient(':memory:');
  t.after(() => db.close());
  const instances = repository(db, 'RunningInstance');
  await initialize(db);
  await instances.insertMany([
    { id: 1, status: 0, started_at: 100 },
    { id: 2, status: 1, started_at: 100, finished_at: 110, exit_code: 0 },
    { id: 3, status: 2, started_at: 100, finished_at: 120, exit_code: 143 },
    { id: 4, status: 3, started_at: 100, finished_at: 130, exit_code: 7 },
  ]);
  const systemConfig = { info: { lang: 'en-US' } };
  const service = {
    set_envs: async () => {},
    getAuthInfo: async () => ({}),
    initializeSystemApp: async () => {},
    refreshApps: async () => {},
  };
  const initData = load('back/loaders/initData.ts', {
    typedi: { Container: { get: () => service } },
    '../services/dependence': class {},
    '../services/cron': class {},
    '../services/env': class {},
    '../services/system': class {},
    '../services/user': class {},
    '../services/open': class {},
    '../data/cron': {
      CrontabModel: { nativeUpdate: async () => {}, find: async () => [] },
      CrontabStatus: { idle: 1 },
    },
    '../data/dependence': {
      DependenceModel: { find: async () => [], nativeUpdate: async () => {} },
      DependenceStatus: { queued: 0 },
    },
    '../data/cronView': {
      CrontabViewModel: { find: async () => [{}] },
      CronViewType: { 系统: 0 },
    },
    '../data/env': {},
    '../data/system': {
      SystemModel: { getOrCreate: async () => systemConfig },
      AuthDataType: {},
    },
    '../data/open': {
      AppModel: {
        findOne: async () => ({ scopes: ['dashboard'] }),
      },
    },
    '../data/runningInstance': {
      RunningInstanceModel: instances,
      InstanceStatus: { running: 0, stopped: 2 },
    },
    '../config': {},
    '../config/util': { fileExist: async () => true, isDemoEnv: () => false },
    '../shared/store': { shareStore: { updateAuthInfo: async () => {} } },
    '../shared/i18n': { setLang() {} },
    './logger': {},
    '../schedule/client': {
      readiness: { configure() {}, recover: async () => {} },
    },
  }).default;
  // Dependency installation is unrelated to startup reconciliation.
  const originalTimeout = global.setTimeout;
  global.setTimeout = () => 0;
  const before = Math.floor(Date.now() / 1000);
  try {
    await initData();
  } finally {
    global.setTimeout = originalTimeout;
  }
  const rows = await instances.find(
    {},
    {
      orderBy: orderBy([['id', 'ASC']]),
    },
  );
  assert.equal(rows[0].status, 2);
  assert.ok(
    rows[0].finished_at >= before &&
      rows[0].finished_at <= Math.floor(Date.now() / 1000),
  );
  assert.equal(rows[0].exit_code, null);
  assert.deepEqual(
    rows
      .slice(1)
      .map(({ status, finished_at, exit_code }) => [
        status,
        finished_at,
        exit_code,
      ]),
    [
      [1, 110, 0],
      [2, 120, 143],
      [3, 130, 7],
    ],
  );
  global.setTimeout = () => 0;
  try {
    await initData();
  } finally {
    global.setTimeout = originalTimeout;
  }
  assert.deepEqual(
    await instances.find(
      {},
      {
        orderBy: orderBy([['id', 'ASC']]),
      },
    ),
    rows,
  );
});
