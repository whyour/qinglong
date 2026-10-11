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
      '../shared/pLimit': {
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
