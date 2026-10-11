const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const decorators = { Service: () => (x) => x, Inject: () => () => {} };
async function fixture(t) {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const rows = db.define('System', {
    type: DataTypes.STRING,
    info: DataTypes.JSON,
  });
  await db.sync();
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
    notificationService: { notify: async () => true },
  });
  service.getDb = async () => ({ info: { type: 'email' } });
  return { rows, service };
}
test('writes cap logs without reading the page and preserve other system data', async (t) => {
  const { rows, service } = await fixture(t);
  await rows.create({ type: 'authConfig', info: { keep: true } });
  for (let i = 0; i < 205; i++)
    await service.notify({ title: String(i), content: 'body' });
  assert.equal(await rows.count({ where: { type: 'notifyLog' } }), 200);
  const logs = await service.getNotifyLog();
  assert.equal(logs[0].title, '204');
  assert.equal(logs.at(-1).title, '5');
  assert.equal(logs[0].notifyType, 'email');
  assert.equal(await rows.count({ where: { type: 'authConfig' } }), 1);
});
test('audit DB failure does not turn a successful notification into failure', async (t) => {
  const { rows, service } = await fixture(t);
  const create = rows.create;
  rows.create = async () => {
    throw Error('disk full');
  };
  try {
    assert.equal(
      (await service.notify({ title: 'ok', content: 'ok' })).code,
      200,
    );
  } finally {
    rows.create = create;
  }
});
test('failed sends are recorded and message size is bounded', async (t) => {
  const { service } = await fixture(t);
  service.notificationService.notify = async () => false;
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
