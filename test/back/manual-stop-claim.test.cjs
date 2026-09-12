const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const { killTask } = require('../../back/config/util');
const { LogStreamManager } = require('../../back/shared/logStreamManager');

for (const conflict of ['stop', 'newer-queue', 'stop-requeue']) {
  test(
    `manual startup loses its conditional claim after ${conflict} and terminates the late child`,
    { timeout: 10000 },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-manual-claim-'));
      const db = new Sequelize({
        dialect: 'sqlite',
        storage: ':memory:',
        logging: false,
      });
      t.after(async () => {
        await db.close();
        await fs.rm(root, { recursive: true, force: true });
      });
      const crons = db.define('Cron', {
        status: DataTypes.INTEGER,
        pid: DataTypes.INTEGER,
        log_path: DataTypes.STRING,
        queued_token: DataTypes.STRING,
        command: DataTypes.STRING,
      });
      const instances = db.define('Instance', {
        cron_id: DataTypes.INTEGER,
        status: DataTypes.INTEGER,
        pid: DataTypes.INTEGER,
      });
      await db.sync();
      await crons.create({
        id: 1,
        status: 3,
        pid: null,
        log_path: 'previous.log',
        command: 'ignored',
      });
      let release,
        entered,
        child,
        released = 0;
      const pending = new Promise((resolve) => (entered = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      const logs = new LogStreamManager(root);
      t.after(() => logs.closeAll());
      const CronService = load('back/services/cron.ts', {
        '../config': { logPath: root },
        '../data/cron': {
          CrontabModel: crons,
          CrontabStatus: { queued: 3, running: 0, idle: 1 },
        },
        '../data/runningInstance': {
          RunningInstanceModel: instances,
          InstanceStatus: { running: 0, stopped: 2 },
        },
        '../config/util': {
          getUniqPath: async () => {
            entered();
            await gate;
            return 'task';
          },
          killTask,
        },
        '../config/const': {},
        '../schedule/client': {},
        '../shared/pLimit': {
          manualRunWithCronLimit: async (fn) => {
            try {
              return await fn();
            } finally {
              released++;
            }
          },
        },
        '../shared/utils': {},
        '../shared/i18n': { t: (s) => s },
        '../shared/logReader': {},
        '../shared/logStreamManager': { logStreamManager: logs },
        'cross-spawn': {
          spawn: () => {
            child = spawn(process.execPath, [
              '-e',
              'setInterval(() => {}, 1000)',
            ]);
            t.after(() => {
              if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGKILL');
            });
            return child;
          },
        },
      }).default;
      const service = new CronService({ info() {}, error() {} });
      service.getDb = async () =>
        (await crons.findByPk(1)).get({ plain: true });
      service.makeCommand = () => 'ignored';
      const running = service.runSingle(1);
      await pending;
      if (conflict === 'stop-requeue') {
        await service.stop([1]);
        // Queue again through the real API; leave the new runner pending.
        const pendingRuns = [];
        service.runSingle = (id, token) => pendingRuns.push({ id, token });
        await service.run([1]);
        assert.equal(pendingRuns.length, 1);
        assert.equal(
          pendingRuns[0].token,
          (await crons.findByPk(1)).queued_token,
        );
      } else if (conflict === 'stop') await service.stop([1]);
      else await crons.update({ log_path: 'newer.log' }, { where: { id: 1 } });
      release();
      const result = await running;
      assert.match(result.error.message, /stopped or superseded/);
      assert.ok(child.signalCode || child.exitCode !== null);
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      const row = await crons.findByPk(1);
      assert.equal(row.status, conflict === 'stop' ? 1 : 3);
      assert.equal(
        row.log_path,
        conflict === 'newer-queue' ? 'newer.log' : 'previous.log',
      );
      assert.equal(row.pid, null);
      assert.equal(released, 1);
    },
  );
}

test(
  'verified termination waits for a SIGTERM-resistant target to exit',
  { timeout: 5000 },
  async (t) => {
    const child = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)',
    ]);
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    await killTask(child.pid, true);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.equal(child.signalCode, 'SIGKILL');
  },
);

test('a runner waiting for a concurrency slot cannot adopt a newer queued generation', async (t) => {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const crons = db.define('Cron', {
    status: DataTypes.INTEGER,
    pid: DataTypes.INTEGER,
    log_path: DataTypes.STRING,
    queued_token: DataTypes.STRING,
  });
  await db.sync();
  await crons.create({ id: 1, status: 1, log_path: 'same.log' });
  const waiting = [];
  const CronService = load('back/services/cron.ts', {
    '../config': {},
    '../data/cron': {
      CrontabModel: crons,
      CrontabStatus: { queued: 3, idle: 1, running: 0 },
    },
    '../data/runningInstance': {
      RunningInstanceModel: { findAll: async () => [] },
      InstanceStatus: { running: 0 },
    },
    '../config/util': {
      getUniqPath: () => assert.fail('stale runner must not prepare a child'),
    },
    '../config/const': {},
    '../schedule/client': {},
    '../shared/pLimit': {
      manualRunWithCronLimit: (fn) => {
        waiting.push(fn);
        return Promise.resolve();
      },
    },
    '../shared/utils': {},
    '../shared/i18n': {},
    '../shared/logReader': {},
    '../shared/logStreamManager': {},
    'cross-spawn': { spawn: () => assert.fail('stale runner must not spawn') },
  }).default;
  const errors = [];
  const service = new CronService({ error: (...args) => errors.push(args) });
  await service.run([1]);
  const first = (await crons.findByPk(1)).queued_token;
  await service.stop([1]);
  await service.run([1]);
  const second = (await crons.findByPk(1)).queued_token;
  assert.notEqual(first, second);
  assert.equal(waiting.length, 2);
  await waiting[0]();
  const row = await crons.findByPk(1);
  assert.equal(row.status, 3);
  assert.equal(row.queued_token, second);
  assert.equal(row.log_path, 'same.log');
  assert.deepEqual(errors, []);
});
