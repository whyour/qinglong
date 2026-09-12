const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
async function fixture(t, onKill = async () => {}) {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const crons = db.define('Cron', {
    command: DataTypes.STRING,
    status: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    log_path: DataTypes.STRING,
        queued_token: DataTypes.STRING,
    last_execution_time: DataTypes.INTEGER,
    last_running_time: DataTypes.INTEGER,
  });
  const instances = db.define('Instance', {
    cron_id: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    status: DataTypes.INTEGER,
    exit_code: DataTypes.INTEGER,
    finished_at: DataTypes.INTEGER,
  });
  await db.sync();
  await crons.bulkCreate([
    { id: 1, command: 'task one.js', status: 0, pid: 101, log_path: 'one.log' },
    { id: 2, command: 'task two.js', status: 0, pid: 201, log_path: 'two.log' },
  ]);
  await instances.bulkCreate([
    { id: 1, cron_id: 1, pid: 101, status: 0 },
    { id: 2, cron_id: 1, pid: 102, status: 0 },
    { id: 3, cron_id: 1, pid: 99, status: 1, exit_code: 0 },
    { id: 4, cron_id: 1, pid: 98, status: 3, exit_code: 7 },
    { id: 5, cron_id: 2, pid: 201, status: 0 },
  ]);
  let service;
  const killed = [];
  const CronService = load(path.resolve('back/services/cron.ts'), {
    '../config': {},
    '../data/cron': {
      CrontabModel: crons,
      CrontabStatus: { queued: 3, running: 0, idle: 1 },
    },
    '../data/runningInstance': {
      RunningInstanceModel: instances,
      InstanceStatus: { running: 0, finished: 1, stopped: 2, error: 3 },
    },
    '../config/util': {
      killTask: async (pid, wait) => {
        assert.equal(wait, true);
        killed.push(pid);
        await onKill({ pid, service, instances, crons });
      },
      killAllTasks: async () => {
        throw Error('command-wide scans must not run');
      },
    },
    '../config/const': {},
    '../schedule/client': {},
    '../shared/pLimit': {},
    '../shared/utils': {},
    '../shared/i18n': { t: (s) => s },
    '../shared/logReader': {},
    '../shared/logStreamManager': {},
    '../shared/childProcess': require('../../back/shared/childProcess'),
  }).default;
  service = new CronService({ info() {}, error() {} });
  service.getDb = ({ id }) => crons.findByPk(id);
  return { service, instances, crons, killed };
}
async function report(service, pid, code) {
  await service.status({
    ids: [1],
    status: 1,
    pid,
    log_path: 'one.log',
    last_running_time: 1,
    last_execution_time: 100,
    exit_code: code,
  });
}
test('stop wins when shell exit writes error or success during termination, preserving exit codes', async (t) => {
  const f = await fixture(t, async ({ service }) => {
    await report(service, 101, 143);
    await report(service, 102, 0);
  });
  await f.service.stop([1]);
  const rows = await f.instances.findAll({ order: [['id', 'ASC']], raw: true });
  assert.deepEqual(
    rows.map((r) => [r.id, r.status, r.exit_code]),
    [
      [1, 2, 143],
      [2, 2, 0],
      [3, 1, 0],
      [4, 3, 7],
      [5, 0, null],
    ],
  );
});
test('late shell completion cannot overwrite stopped instances', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1]);
  await report(f.service, 101, 143);
  assert.equal((await f.instances.findByPk(1)).status, 2);
  assert.equal((await f.instances.findByPk(2)).status, 2);
});
test('rows created after the stop snapshot are not relabelled', async (t) => {
  const f = await fixture(t, async ({ instances }) => {
    if (!(await instances.findByPk(6)))
      await instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
  });
  await f.service.stop([1]);
  assert.equal((await f.instances.findByPk(6)).status, 0);
  assert.equal((await f.instances.findByPk(1)).status, 2);
});
test('repeated stop does not rewrite historical rows or their finished timestamps', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1]);
  const before = await f.instances.findAll({
    raw: true,
    order: [['id', 'ASC']],
  });
  await f.service.stop([1]);
  assert.deepEqual(
    await f.instances.findAll({ raw: true, order: [['id', 'ASC']] }),
    before,
  );
});
test('batch stop captures running instances from every requested cron', async (t) => {
  const f = await fixture(t);
  await f.service.stop([1, 2]);
  assert.equal((await f.instances.findByPk(5)).status, 2);
  assert.equal((await f.instances.findByPk(3)).status, 1);
});

test('stop signals every snapshotted PID exactly once and preserves a later running instance', async (t) => {
  const f = await fixture(t, async ({ instances, crons }) => {
    if (!(await instances.findByPk(6))) {
      await instances.create({ id: 6, cron_id: 1, pid: 103, status: 0 });
      await crons.update(
        { pid: 103, log_path: 'later.log', status: 0 },
        { where: { id: 1 } },
      );
    }
  });
  await f.service.stop([1]);
  assert.deepEqual(f.killed, [101, 102]);
  assert.equal((await f.instances.findByPk(6)).status, 0);
  assert.equal((await f.crons.findByPk(1)).pid, 103);
  assert.equal((await f.crons.findByPk(1)).status, 0);
});

test('failed termination is not finalized as stopped', async (t) => {
  const f = await fixture(t, async ({ pid }) => {
    if (pid === 102) throw Error('still alive');
  });
  await f.service.stop([1]);
  assert.deepEqual(f.killed, [101, 102]);
  assert.equal((await f.instances.findByPk(1)).status, 2);
  assert.equal((await f.instances.findByPk(2)).status, 0);
  assert.equal((await f.crons.findByPk(1)).status, 0);
});
