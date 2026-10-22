const { DatabaseClient } = require('../../back/data/databaseClient');
const { repository, initialize } = require('../helpers/repository-fixture.cjs');
const { orderBy } = require('../../back/data/queries');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
async function fixture(t, onKill = async () => {}) {
  const db = new DatabaseClient(':memory:');
  t.after(() => db.close());
  const rows = repository(db, 'Subscription');
  await initialize(db);
  await rows.insert({ id: 1, pid: 101, status: 0 });
  const Service = load('back/services/subscription.ts', {
    '../config': {},
    '../data/cron': {},
    '../config/const': {},
    '../data/subscription': {
      SubscriptionModel: rows,
      SubscriptionStatus: { idle: 1 },
    },
    '../config/util': { killTask: async () => onKill(rows) },
    '../config/subscription': {},
    '../shared/i18n': {},
    '../shared/pLimit': {},
    '../shared/logReader': {},
    '../shared/logStreamManager': {},
    './schedule': {},
    './sock': {},
    './sshKey': {},
    './cron': {},
  }).default;
  return { rows, service: new Service({ error() {} }, {}, {}, {}, {}) };
}
test('successful subscription stop clears the stored PID', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1]);
  const row = await f.rows.findOne({
    id: 1,
  });
  assert.equal(row.status, 1);
  assert.equal(row.pid, null);
});
test('subscription stop does not overwrite a replacement process started during termination', async (t) => {
  const f = await fixture(t, async (rows) => {
    await rows.nativeUpdate({ id: 1 }, { pid: 202, status: 0 });
  });
  await f.service.stop([1]);
  const row = await f.rows.findOne({
    id: 1,
  });
  assert.equal(row.status, 0);
  assert.equal(row.pid, 202);
});
test('subscription stop cancels a queued row without a PID', async (t) => {
  const f = await fixture(t, () => assert.fail('queued row has no process'));
  await f.rows.nativeUpdate({ id: 1 }, { pid: null, status: 3 });
  await f.service.stop([1]);
  const row = await f.rows.findOne({
    id: 1,
  });
  assert.equal(row.status, 1);
  assert.equal(row.pid, null);
});
