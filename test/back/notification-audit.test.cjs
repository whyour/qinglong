const { DatabaseClient } = require('../../back/data/databaseClient');
const { repository, initialize } = require('../helpers/repository-fixture.cjs');
const { orderBy } = require('../../back/data/queries');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const decorators = { Service: () => (x) => x, Inject: () => () => {} };
async function fixture(t) {
  const db = new DatabaseClient(':memory:');
  t.after(() => db.close());
  const rows = repository(db, 'Auth');
  await initialize(db);
  const logger = { error() {} };
  const S = load('back/services/system.ts', {
    typedi: decorators,
    '../config': {},
    '../config/const': { NotificationModeStringMap: { 0: 'gotify' } },
    '../config/util': {},
    '../data/dependence': {},
    '../data/system': {
      SystemModel: rows,
      AuthDataType: { notifyLog: 'notifyLog', notification: 'notification' },
      NotifyStatus: { success: 0, fail: 1 },
    },
    './schedule': class {},
    './sock': class {},
    './notify': class {},
    '../shared/pLimit': {},
    '../schedule/client': {},
    '../config/index': {},
    '../shared/store': {},
    '../shared/i18n': { t: (s) => s },
  }).default;
  const service = Object.assign(Object.create(S.prototype), {
    logger,
    notificationService: new (load('back/services/notify.ts', {
      typedi: decorators,
      '../config/util': {},
      '../data/system': {
        SystemModel: rows,
        AuthDataType: { notifyLog: 'notifyLog' },
        NotifyStatus: { success: 0, fail: 1 },
      },
      '../shared/i18n': { t: (s) => s },
      './user': {},
    }).default)(),
  });
  service.notificationService.userService = {
    getNotificationMode: async () => ({ type: 'email' }),
  };
  service.notificationService.modeMap.set('email', async () => true);
  service.getDb = async () => ({ info: { type: 'email' } });
  return { rows, service };
}
test('writes cap logs without reading the page and preserve other system data', async (t) => {
  const { rows, service } = await fixture(t);
  await rows.insert({ type: 'authConfig', info: { keep: true } });
  for (let i = 0; i < 205; i++)
    await service.notify({ title: String(i), content: 'body' });
  assert.equal(await rows.count({ type: 'notifyLog' }), 200);
  const logs = await service.getNotifyLog();
  assert.equal(logs[0].title, '204');
  assert.equal(logs.at(-1).title, '5');
  assert.equal(logs[0].notifyType, 'email');
  assert.equal(await rows.count({ type: 'authConfig' }), 1);
});
test('audit DB failure does not turn a successful notification into failure', async (t) => {
  const { rows, service } = await fixture(t);
  const create = rows.insert;
  rows.insert = async () => {
    throw Error('disk full');
  };
  try {
    assert.equal(
      (await service.notify({ title: 'ok', content: 'ok' })).code,
      200,
    );
  } finally {
    rows.insert = create;
  }
});
test('failed sends are recorded and message size is bounded', async (t) => {
  const { service } = await fixture(t);
  service.notificationService.modeMap.set('gotify', async () => false);
  assert.equal(
    (
      await service.notify({
        title: 'x'.repeat(1000),
        content: 'y'.repeat(20000),
        notificationInfo: { type: 0 },
      })
    ).code,
    400,
  );
  const [row] = await service.getNotifyLog();
  assert.equal(row.status, 1);
  assert.equal(row.title.length, 512);
  assert.equal(row.content.length, 8192);
  assert.equal(row.notifyType, 'gotify');
});
test('script reports share retention and preserve source without sending twice', async (t) => {
  const { service } = await fixture(t);
  await service.recordNotifyLog({
    title: 'task result',
    content: 'body',
    status: 1,
    notifyType: 'smtp',
    source: 'script',
    scriptName: 'job.py',
    taskId: '42',
  });
  const [row] = await service.getNotifyLog();
  assert.equal(row.source, 'script');
  assert.equal(row.scriptName, 'job.py');
  assert.equal(row.taskId, '42');
  assert.equal(row.status, 1);
});
