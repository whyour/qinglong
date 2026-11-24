const assert = require('node:assert/strict');
const test = require('node:test');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');

test('startup closes interrupted instances without inventing exit codes or rewriting history', async (t) => {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const instances = db.define('RunningInstance', {
    cron_id: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    log_path: DataTypes.TEXT,
    status: DataTypes.INTEGER,
    started_at: DataTypes.INTEGER,
    finished_at: DataTypes.INTEGER,
    exit_code: DataTypes.INTEGER,
  });
  const crons = db.define('Crontab', {
    status: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    queued_token: DataTypes.STRING,
    command: DataTypes.STRING,
  });
  await db.sync();
  await db.transaction((tx) =>
    require('../../back/cron/history').installTriggerHistory(db, tx),
  );
  await instances.bulkCreate([
    { id: 1, status: 0, started_at: 100 },
    { id: 2, status: 1, started_at: 100, finished_at: 110, exit_code: 0 },
    { id: 3, status: 2, started_at: 100, finished_at: 120, exit_code: 143 },
    { id: 4, status: 3, started_at: 100, finished_at: 130, exit_code: 7 },
  ]);
  const { TriggerHistory, systemOwner } = require('../../back/cron/history');
  const history = new TriggerHistory(db);
  await crons.create({
    id: 9,
    status: 0,
    pid: process.pid,
    command: 'task live.sh',
  });
  await instances.create({ id: 9, status: 0, started_at: 100 });
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,source,state,owner,instance_id,observed_at) VALUES ('live',9,'system','running',$owner,9,100)",
    { bind: { owner: systemOwner(process.pid) } },
  );
  await history.interrupt('http');
  const systemConfig = { info: { lang: 'en-US' } };
  const startupEvents = [];
  const service = {
    set_envs: async () => {
      startupEvents.push('environment');
    },
    getAuthInfo: async () => ({}),
    initializeSystemApp: async () => {},
    refreshApps: async () => {},
    recoverQueuedTasks: async () => {},
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
      CrontabModel: {
        sequelize: db,
        update: async () => {},
        findAll: async () => [],
      },
      CrontabStatus: { idle: 1 },
    },
    '../data/dependence': {
      DependenceModel: { findAll: async () => [], update: async () => {} },
      DependenceStatus: { queued: 0 },
    },
    '../data/cronView': {
      CrontabViewModel: { findAll: async () => [{}] },
      CronViewType: { 系统: 0 },
    },
    '../data/env': {},
    '../data/system': {
      SystemModel: { findOrCreate: async () => [systemConfig] },
      AuthDataType: {},
    },
    '../data/open': {
      AppModel: {
        findOne: async () => ({ get: () => ({ scopes: ['dashboard'] }) }),
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
      readiness: {
        configure() {},
        recover: async () => {
          startupEvents.push('scheduler');
        },
      },
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
  assert.deepEqual(startupEvents, ['environment', 'scheduler']);
  assert.equal((await instances.findByPk(9)).status, 0);
  assert.equal((await crons.findByPk(9)).pid, process.pid);
  const rows = await instances.findAll({
    where: { id: [1, 2, 3, 4] },
    order: [['id', 'ASC']],
    raw: true,
  });
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
  assert.deepEqual(startupEvents, [
    'environment',
    'scheduler',
    'environment',
    'scheduler',
  ]);
  assert.deepEqual(
    await instances.findAll({
      where: { id: [1, 2, 3, 4] },
      order: [['id', 'ASC']],
      raw: true,
    }),
    rows,
  );
});
