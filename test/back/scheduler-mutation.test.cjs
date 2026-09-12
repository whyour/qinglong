const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Sequelize, DataTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-scheduler-mutation-'),
  );
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const crons = db.define('Cron', {
    name: DataTypes.STRING,
    command: DataTypes.STRING,
    schedule: DataTypes.STRING,
    isDisabled: DataTypes.INTEGER,
    saved: DataTypes.BOOLEAN,
    queued_token: DataTypes.STRING,
  });
  await db.sync();
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const jobs = new Map();
  const client = {
    addCron: async (items, replace) => {
      if (replace) jobs.clear();
      items.forEach((item) => jobs.set(item.id, item.command));
    },
    delCron: async (ids) => ids.forEach((id) => jobs.delete(id)),
  };
  const CronService = load('back/services/cron.ts', {
    '../config': {
      crontabFile: path.join(root, 'crontab.list'),
      logPath: root,
    },
    '../data/cron': {
      CrontabModel: crons,
      Crontab: class {
        constructor(options) {
          Object.assign(this, { isDisabled: 0 }, options);
        }
      },
    },
    '../data/runningInstance': {},
    '../config/util': { isDemoEnv: () => false },
    '../config/const': {},
    '../schedule/client': client,
    '../shared/pLimit': {},
    '../shared/utils': {},
    '../shared/i18n': { t: (s) => s },
    '../shared/logReader': {},
    '../shared/logStreamManager': {},
  }).default;
  const service = new CronService({ error() {}, warn() {}, info() {} });
  service.getLogName = async () => 'task';
  service.shouldUseCronClient = () => true;
  service.makeCommand = (doc) => doc.command;
  service.crontabs = async () => ({ data: await crons.findAll({ raw: true }) });
  service.setCrontab = async () => {};
  return { service, crons, jobs, client, root };
}

for (const operation of ['create', 'update', 'remove', 'disabled', 'enabled']) {
  test(`recovery snapshot cannot overwrite concurrent ${operation}`, async (t) => {
    const { service, crons, jobs } = await fixture(t);
    await crons.create({
      id: 1,
      command: 'old',
      schedule: '* * * * *',
      isDisabled: operation === 'enabled' ? 1 : 0,
    });
    const entered = gate(),
      release = gate();
    let first = true;
    service.setCrontab = async () => {
      if (first) {
        first = false;
        entered.release();
        await release.promise;
      }
    };
    const recovery = service.autosave_crontab(true);
    await entered.promise;
    const before = await crons.findAll({ raw: true });
    const mutation =
      operation === 'create'
        ? service.create({ command: 'new', schedule: '* * * * *' })
        : operation === 'update'
        ? service.update({ id: 1, command: 'new' })
        : service[operation]([1]);
    await delay(50);
    assert.deepEqual(
      await crons.findAll({ raw: true }),
      before,
      'DB writes must also wait for recovery',
    );
    release.release();
    await Promise.all([recovery, mutation]);
    const rows = await crons.findAll({ raw: true });
    assert.deepEqual(
      [...jobs.entries()].sort(),
      rows
        .filter((row) => !row.isDisabled)
        .map((row) => [String(row.id), row.command])
        .sort(),
    );
  });
}

test('recovery waits for an admitted mutation to finish registration before reading the DB', async (t) => {
  const { service, client, jobs } = await fixture(t);
  const entered = gate(),
    release = gate();
  const add = client.addCron;
  client.addCron = async (items, replace) => {
    if (!replace) {
      entered.release();
      await release.promise;
    }
    return add(items, replace);
  };
  const mutation = service.create({ command: 'new', schedule: '* * * * *' });
  await entered.promise;
  let reads = 0;
  const read = service.crontabs;
  service.crontabs = async () => {
    reads++;
    return read();
  };
  const recovery = service.autosave_crontab(true);
  await delay(50);
  assert.equal(reads, 0);
  release.release();
  await Promise.all([mutation, recovery]);
  assert.deepEqual([...jobs.values()], ['new']);
});

for (const operation of ['create', 'update', 'enabled']) {
  test(`${operation} preserves scheduler 503 after rollback and releases its lock`, async (t) => {
    const { service, crons, client } = await fixture(t);
    if (operation !== 'create')
      await crons.create({
        id: 1,
        command: 'old',
        schedule: '* * * * *',
        isDisabled: operation === 'enabled' ? 1 : 0,
      });
    const cause = Object.assign(Error('unavailable'), { status: 503 });
    client.addCron = async () => {
      throw cause;
    };
    const mutation =
      operation === 'create'
        ? service.create({ command: 'new', schedule: '* * * * *' })
        : operation === 'update'
        ? service.update({ id: 1, command: 'new' })
        : service.enabled([1]);
    await assert.rejects(
      mutation,
      (err) =>
        err.status === 503 && err.cause === cause && /回滚/.test(err.message),
    );
    if (operation === 'create') assert.equal(await crons.count(), 0);
    else {
      const row = await crons.findByPk(1);
      assert.equal(row.command, 'old');
      assert.equal(row.isDisabled, operation === 'enabled' ? 1 : 0);
    }
    client.addCron = async () => {};
    await service.autosave_crontab(true);
  });
}

test(
  'scheduler lock excludes a second OS process and leaves no lock after completion',
  { timeout: 10000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ql-scheduler-process-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { crontabFile: path.join(root, 'crontab.list') };
    const { withSchedulerMutation } = load(
      'back/shared/schedulerMutationLock.ts',
      { '../config': config },
    );
    const entered = gate(),
      release = gate();
    const owner = withSchedulerMutation(async () => {
      entered.release();
      await release.promise;
    });
    await entered.promise;
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const load = require('./test/helpers/load-security-module.cjs');
    const { withSchedulerMutation } = load('back/shared/schedulerMutationLock.ts', {'../config': JSON.parse(process.argv[1])});
    process.send('attempting');
    withSchedulerMutation(async () => process.send('entered')).then(() => process.disconnect()).catch(err => { console.error(err); process.exit(1); });
  `,
        JSON.stringify(config),
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      release.release();
    });
    const closed = once(child, 'close');
    assert.equal((await once(child, 'message'))[0], 'attempting');
    let acquired = false;
    const acquisition = once(child, 'message').then(([message]) => {
      acquired = true;
      assert.equal(message, 'entered');
    });
    await delay(150);
    assert.equal(acquired, false);
    release.release();
    await owner;
    await acquisition;
    assert.equal((await closed)[0], 0);
    await assert.rejects(fs.stat(`${config.crontabFile}.scheduler.lock`), {
      code: 'ENOENT',
    });
  },
);

test('configuration rollback cannot restore an obsolete manual queue token', async (t) => {
  const { service, crons, client } = await fixture(t);
  await crons.create({
    id: 1,
    command: 'old',
    schedule: '* * * * *',
    isDisabled: 0,
    queued_token: 'old-token',
  });
  let first = true;
  client.addCron = async () => {
    if (first) {
      first = false;
      await crons.update({ queued_token: 'new-token' }, { where: { id: 1 } });
      throw Object.assign(Error('unavailable'), { status: 503 });
    }
  };
  await assert.rejects(
    service.update({ id: 1, command: 'new' }),
    (err) => err.status === 503,
  );
  const row = await crons.findByPk(1);
  assert.equal(row.command, 'old');
  assert.equal(row.queued_token, 'new-token');
});
