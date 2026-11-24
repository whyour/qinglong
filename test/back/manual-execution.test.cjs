const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
const { LogStreamManager } = require('../../back/shared/logStreamManager');

test(
  'manual execution captures a short child before slow status storage and flushes before release',
  { timeout: 5000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-manual-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const logs = new LogStreamManager(root);
    const updates = [];
    let active = 0;
    let failSpawn = false;
    const CronService = load(path.resolve('back/services/cron.ts'), {
      '../config': { logPath: root },
      '../data/cron': {
        CrontabStatus: { queued: 3, running: 0, idle: 1 },
        CrontabModel: {
          update: async (data, options) => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            updates.push({ data, options });
            return [1];
          },
        },
      },
      '../data/runningInstance': {
        RunningInstanceModel: {},
        InstanceStatus: {},
      },
      '../config/util': { getUniqPath: async () => 'task' },
      '../config/const': { TASK_PREFIX: 'task ', QL_PREFIX: 'ql ' },
      '../schedule/client': {},
      '../cron/execution/cronLimit': {
        manualRunWithCronLimit: async (fn) => {
          active++;
          try {
            return await fn();
          } finally {
            active--;
          }
        },
      },
      '../shared/utils': {},
      '../shared/i18n': { t: (s) => s },
      '../shared/logReader': {},
      '../shared/logStreamManager': { logStreamManager: logs },
      'cross-spawn': {
        spawn: () =>
          failSpawn
            ? spawn('true', { shell: '/nonexistent-ql-manual-shell' })
            : spawn(process.execPath, [
                '-e',
                'process.stdout.write("末尾\\n")',
              ]),
      },
    }).default;
    const service = new CronService({ info() {}, error() {} });
    service.getDb = async () => ({
      id: 1,
      status: 3,
      command: 'ignored',
      log_path: '',
    });
    service.makeCommand = () => 'ignored';
    await service.runSingle(1);
    const [file] = await fs.readdir(path.join(root, 'task'));
    assert.equal(
      await fs.readFile(path.join(root, 'task', file), 'utf8'),
      '末尾\n',
    );
    assert.equal(logs.getOpenStreamCount(), 0);
    assert.equal(active, 0);
    assert.equal(updates.at(-1).data.status, 1);
    failSpawn = true;
    await service.runSingle(1);
    assert.equal(active, 0);
    assert.equal(updates.at(-1).data.status, 1);
  },
);

test('manual tasks sharing a directory and millisecond keep separate complete logs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-manual-collision-'));
  const logs = new LogStreamManager(root);
  t.after(async () => {
    await logs.closeAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  let child = 0;
  const CronService = load(path.resolve('back/services/cron.ts'), {
    dayjs: () => ({
      format: () => '2026-11-24-00-00-00-000',
      unix: () => 1795449600,
    }),
    '../config': { logPath: root },
    '../data/cron': {
      CrontabStatus: { queued: 3, running: 0, idle: 1 },
      CrontabModel: { update: async () => [1] },
    },
    '../data/runningInstance': {
      RunningInstanceModel: {},
      InstanceStatus: {},
    },
    '../config/util': { getUniqPath: async () => 'shared-script' },
    '../config/const': { TASK_PREFIX: 'task ', QL_PREFIX: 'ql ' },
    '../schedule/client': {},
    '../cron/execution/cronLimit': {
      manualRunWithCronLimit: async (fn) => fn(),
    },
    '../shared/utils': {},
    '../shared/i18n': { t: (s) => s },
    '../shared/logReader': {},
    '../shared/logStreamManager': { logStreamManager: logs },
    'cross-spawn': {
      spawn: () =>
        spawn(process.execPath, [
          '-e',
          `process.stdout.write(${JSON.stringify(`任务-${++child}\n`)});`,
        ]),
    },
  }).default;
  const errors = [];
  const service = new CronService({
    info() {},
    error: (...args) => errors.push(args),
  });
  service.getDb = async ({ id }) => ({
    id,
    status: 3,
    command: 'ignored',
    log_path: '',
  });
  service.makeCommand = () => 'ignored';
  await Promise.all([service.runSingle(1), service.runSingle(2)]);
  // A subsequent launch in the same millisecond must also get a fresh path.
  await service.runSingle(1);
  const files = await fs.readdir(path.join(root, 'shared-script'));
  assert.equal(files.length, 3);
  const contents = await Promise.all(
    files.map((file) =>
      fs.readFile(path.join(root, 'shared-script', file), 'utf8'),
    ),
  );
  assert.deepEqual(contents.sort(), ['任务-1\n', '任务-2\n', '任务-3\n']);
  assert.deepEqual(errors, []);
  assert.equal(logs.getOpenStreamCount(), 0);
});

test('independent tasks sharing a submission token and timestamp allocate distinct log paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-independent-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = [];
  const CronService = load(path.resolve('back/services/cron.ts'), {
    dayjs: () => ({ format: () => '2026-11-24-00-00-00-000' }),
    '../config': { logPath: root },
    '../data/cron': {
      CrontabStatus: { queued: 3, running: 0, idle: 1 },
      CrontabModel: { update: async () => [1] },
    },
    '../data/runningInstance': { RunningInstanceModel: {}, InstanceStatus: {} },
    '../config/util': { getUniqPath: async () => 'shared-script' },
    '../config/const': {},
    '../schedule/client': {},
    '../cron/history': {
      TriggerHistory: class {
        async claimManual() {
          return 'started';
        }
        async complete() {}
      },
    },
    '../cron/execution/cronLimit': {
      manualRunWithCronLimit: async (fn) => fn(),
    },
    '../cron/execution/cronCommandProcess': {
      spawnCronCommand: (_command, _trigger, _options, outputPath) => {
        paths.push(outputPath);
        throw new Error('stop after log allocation');
      },
    },
    '../shared/utils': {},
    '../shared/i18n': { t: (s) => s },
    '../shared/logReader': {},
    '../shared/logStreamManager': {
      logStreamManager: { closeStream: async () => {} },
    },
  }).default;
  const service = new CronService({ info() {}, error() {} });
  service.getDb = async ({ id }) => ({ id, allow_multiple_instances: true });
  service.makeCommand = () => 'ignored';
  await Promise.all(
    [1, 2].map((id) =>
      service.runSingle(id, 'shared-token', `shared-token-${id}`, {
        allow_multiple_instances: true,
      }),
    ),
  );
  assert.equal(paths.length, 2);
  assert.equal(new Set(paths).size, 2);
});
