const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { Sequelize, Transaction } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const {
  TriggerHistory,
  installTriggerHistory,
} = require('../../back/cron/history');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-run-receipt-'));
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'panel.sqlite'),
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
  });
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const models = load('back/data/cron.ts', { './index': { sequelize: db } });
  const instances = load('back/data/runningInstance.ts', {
    './index': { sequelize: db },
  });
  load('back/data/cronStats.ts', { './index': { sequelize: db } });
  await db.sync();
  await db.transaction((transaction) => installTriggerHistory(db, transaction));
  const history = new TriggerHistory(db);
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../data/runningInstance': instances,
    '../config/index': { logPath: root },
    '../cron/execution/cronLimit': {},
    '../schedule/client': {},
    '../shared/logStreamManager': {},
    '../config/util': {
      fileExist: async (file) => {
        try {
          await fs.access(file);
          return true;
        } catch {
          return false;
        }
      },
    },
  }).default;
  const service = new Service({ error() {}, info() {}, warn() {} });
  const launched = [];
  service.runSingle = async (...args) => {
    launched.push(args);
  };
  await models.CrontabModel.bulkCreate([
    {
      id: 1,
      command: 'true',
      isDisabled: 0,
      status: 1,
      allow_multiple_instances: 1,
    },
    {
      id: 2,
      command: 'sleep 1',
      isDisabled: 0,
      status: 0,
      pid: process.pid,
      allow_multiple_instances: 0,
    },
  ]);
  return { root, db, models, history, service, launched };
}

test('run returns committed per-task receipts including overlap skips and preserves dispatch identity', async (t) => {
  const { service, launched, history, models } = await fixture(t);
  const receipts = await service.run([1, 2, 1, 999]);
  assert.equal(receipts.length, 2);
  const queued = receipts.find((row) => row.taskId === 1);
  const skipped = receipts.find((row) => row.taskId === 2);
  assert.deepEqual(
    { ...queued, triggerId: 'id' },
    { taskId: 1, triggerId: 'id', state: 'queued', reason: null },
  );
  assert.deepEqual(
    { ...skipped, triggerId: 'id' },
    { taskId: 2, triggerId: 'id', state: 'skipped', reason: 'overlap' },
  );
  for (const receipt of receipts) {
    const [row] = await history.visibleTriggers(receipt.taskId, [
      receipt.triggerId,
    ]);
    assert.equal(row.state, receipt.state);
    assert.equal(row.reason, receipt.reason);
  }
  assert.equal(launched.length, 1);
  assert.equal(launched[0][0], 1);
  assert.equal(launched[0][2], queued.triggerId);
  assert.equal(
    (await models.CrontabModel.findByPk(1)).queued_token,
    launched[0][1],
  );
  const [next] = await service.run([1]);
  assert.notEqual(next.triggerId, queued.triggerId);
  assert.deepEqual(await service.run([999]), []);
  const [boot] = await service.run([1], 'boot');
  assert.equal(
    (await history.visibleTriggers(1, [boot.triggerId]))[0].source,
    'boot',
  );
});

test('transaction failure publishes neither a receipt nor a dispatch', async (t) => {
  const { service, launched, history, models } = await fixture(t);
  t.mock.method(models.CrontabModel, 'update', async () => {
    throw new Error('write failed');
  });
  await assert.rejects(service.run([1]), /write failed/);
  assert.deepEqual(await history.recent(1, 0), []);
  assert.deepEqual(launched, []);
});

test('HTTP run receipts select their own history and logs despite a newer sibling run', async (t) => {
  const { service, history, db, root } = await fixture(t);
  const router = express.Router();
  load('back/api/cron.ts', {
    typedi: { Container: { get: () => service } },
    '../services/cron': class {},
    '../services/cronView': class {},
    '../schedule/client': { readiness: { ensureReady: async () => {} } },
    '../validation/schedule': { commonCronSchema: {} },
    '../cron/history': { triggerHistory: () => history },
  }).default(router);
  const server = express()
    .use(express.json())
    .use('/api', router)
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/crons`;
  const run = () =>
    fetch(`${base}/run`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '[1]',
    }).then((r) => r.json());
  const first = await run();
  const second = await run();
  assert.equal(first.code, 200);
  const a = first.data[0].triggerId,
    b = second.data[0].triggerId;
  assert.notEqual(a, b);
  for (const [id, name] of [
    [a, 'first'],
    [b, 'second'],
  ]) {
    await fs.writeFile(path.join(root, `${name}.log`), `${name} execution\n`);
    await db.query(
      "UPDATE CronTriggers SET state='finished',exit_code=0,log_path=$file WHERE id=$id",
      { bind: { id, file: `${name}.log` } },
    );
  }
  const selected = await fetch(
    `${base}/1/triggers?${new URLSearchParams({ ids: a })}`,
  ).then((r) => r.json());
  assert.equal(selected.data.length, 1);
  assert.equal(selected.data[0].id, a);
  const log = await fetch(
    `${base}/1/log?${new URLSearchParams({ triggerId: a })}`,
  ).then((r) => r.json());
  assert.equal(log.triggerId, a);
  assert.equal(log.data, 'first execution\n');
  const wrongTask = await fetch(
    `${base}/2/log?${new URLSearchParams({ triggerId: a })}`,
  ).then((r) => r.json());
  assert.equal(wrongTask.logStatus, 'notFound');
  assert.doesNotMatch(wrongTask.data, /first execution|second execution/);
});
