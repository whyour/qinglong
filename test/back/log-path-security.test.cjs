const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');
const { LogStreamManager } = require('../../back/shared/logStreamManager');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-boundary-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'log');
  const outside = path.join(base, 'log-other');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const victim = path.join(outside, 'victim.log');
  await fs.writeFile(victim, 'unchanged');
  await fs.symlink(outside, path.join(root, 'escape-dir'));
  await fs.symlink(victim, path.join(root, 'escape-file'));
  await fs.symlink(
    path.join(outside, 'missing.log'),
    path.join(root, 'dangling'),
  );
  const invalid = [
    path.join(root, '..', 'log-other', 'new.log'),
    path.join(root, 'escape-dir', 'new.log'),
    path.join(root, 'escape-file'),
    path.join(root, 'dangling'),
    root,
    path.join(root, 'bad\0name'),
  ];
  return { root, outside, victim, invalid };
}

test('log streams reject traversal, sibling prefixes and escaping symlinks before writing', async (t) => {
  const { root, outside, victim, invalid } = await fixture(t);
  const manager = new LogStreamManager(root);
  for (const target of invalid) {
    await assert.rejects(
      manager.write(target, 'overwrite'),
      /outside the log directory/,
    );
    await assert.rejects(
      manager.closeStream(target),
      /outside the log directory/,
    );
    assert.equal(manager.getOpenStreamCount(), 0);
  }
  assert.equal(await fs.readFile(victim, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(outside), ['victim.log']);
  const folder = path.join(root, '中文 日志');
  await fs.mkdir(folder);
  const log = path.join(folder, 'task.log');
  await Promise.all([
    manager.write(log, '开始\n'),
    manager.write(log, '结束\n'),
  ]);
  await manager.closeAll();
  assert.equal(await fs.readFile(log, 'utf8'), '开始\n结束\n');
});

test('log initialization rejects unsafe paths before mkdir or file writes', async (t) => {
  const { root, outside, victim, invalid } = await fixture(t);
  const { handleLogPath } = load(path.resolve('back/config/util.ts'), {
    './index': { logPath: root },
    './share': {},
    '../loaders/logger': {},
    '../shared/utils': {
      writeFileWithLock: (file, data) => fs.writeFile(file, data),
    },
    '../data/dependence': { DependenceTypes: {} },
  });
  for (const target of invalid) {
    await assert.rejects(
      handleLogPath(target, 'overwrite'),
      /outside the log directory/,
    );
  }
  await assert.rejects(
    handleLogPath('../log-other/new/sub/task.log', 'overwrite'),
    /outside the log directory/,
  );
  assert.equal(await fs.readFile(victim, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(outside), ['victim.log']);
  const log = await handleLogPath('中文 日志/nested/task.log', 'initial');
  assert.equal(await fs.readFile(log, 'utf8'), 'initial');
  assert.equal(await handleLogPath(log, 'ignored'), log);
  assert.equal(await fs.readFile(log, 'utf8'), 'initial');
});

test('manual execution rejects escaping log names before creating directories or spawning', async (t) => {
  const { root, outside, victim } = await fixture(t);
  let spawned = 0;
  let releases = 0;
  const errors = [];
  const CronService = load(path.resolve('back/services/cron.ts'), {
    '../config': { logPath: root },
    '../data/cron': {
      CrontabStatus: { queued: 3, idle: 1 },
      CrontabModel: { update: async () => {} },
    },
    '../data/runningInstance': { RunningInstanceModel: {}, InstanceStatus: {} },
    '../config/util': {},
    '../config/const': {},
    '../schedule/client': {},
    '../shared/pLimit': {
      manualRunWithCronLimit: async (fn) => {
        try {
          return await fn();
        } finally {
          releases++;
        }
      },
    },
    '../shared/utils': {},
    '../shared/i18n': { t: (s) => s },
    '../shared/logReader': {},
    '../shared/logStreamManager': {
      logStreamManager: { closeStream: async () => {} },
    },
    'cross-spawn': {
      spawn: () => {
        spawned++;
        throw new Error('must not spawn');
      },
    },
  }).default;
  const service = new CronService({
    info() {},
    error: (...args) => errors.push(args),
  });
  for (const log_name of [
    '../log-other/new',
    outside,
    'escape-dir/new',
    'dangling',
    'bad\0name',
  ]) {
    service.getDb = async () => ({
      id: 1,
      status: 3,
      command: 'ignored',
      log_path: '',
      log_name,
    });
    await service.runSingle(1);
  }
  assert.equal(spawned, 0);
  assert.equal(releases, 5);
  assert.equal(
    errors.filter((args) =>
      args.includes('Log path is outside the log directory'),
    ).length,
    5,
  );
  assert.equal(await fs.readFile(victim, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(outside), ['victim.log']);
});
