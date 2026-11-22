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
      fileExist: (file) =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
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
    '../cron/execution/cronLimit': {
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

test('creating log folders normalizes valid absolute paths and rejects sibling or symlink escapes before mkdir', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logs = path.join(root, 'log'),
    outside = path.join(root, 'log-other');
  await Promise.all([fs.mkdir(logs), fs.mkdir(outside)]);
  await fs.symlink(outside, path.join(logs, 'escape'));
  const Service = load(path.resolve('back/services/cron.ts'), {
    '../config': { logPath: logs },
    '../config/util': {},
    '../data/cron': {},
    '../data/runningInstance': {},
    '../schedule/client': {},
    '../cron/execution/cronLimit': {},
    '../shared/logStreamManager': {},
    '../loaders/logger': {},
  }).default;
  const service = new Service({});
  for (const candidate of [
    path.join(outside, 'new'),
    'escape/new',
    '../log-other/new',
  ])
    await assert.rejects(service.getLogName({ log_name: candidate }), {
      status: 400,
    });
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(
    await service.getLogName({ log_name: path.join(logs, 'safe') }),
    'safe',
  );
  assert.ok((await fs.stat(path.join(logs, 'safe'))).isDirectory());
});

test('a cursor from the previous run reads the tail of the current log instead of splicing two files', async (t) => {
  const { root } = await fixture(t);
  const Service = load(path.resolve('back/services/cron.ts'), {
    '../config': { logPath: root },
    '../config/util': { fileExist: async (p) => (await fs.stat(p)).isFile() },
    '../data/cron': { CrontabStatus: { running: 0, queued: 3 } },
    '../data/runningInstance': {},
    '../schedule/client': {},
    '../cron/execution/cronLimit': {},
    '../shared/logStreamManager': {},
    '../loaders/logger': {},
  }).default;
  const service = new Service({});
  service.getDb = async () => ({ status: 0, log_path: 'current.log' });
  await fs.writeFile(path.join(root, 'current.log'), 'current example');
  const resumed = await service.log(1, {
    offset: 3,
    previousPath: 'current.log',
    limit: 7,
  });
  assert.equal(resumed.content, 'rent ex');
  const switched = await service.log(1, {
    offset: 3,
    previousPath: '../previous.log',
    limit: 7,
  });
  assert.equal(switched.content, 'example');
  assert.equal(switched.logPath, 'current.log');
  const followed = await service.log(1, {
    offset: 3,
    previousPath: 'previous.log',
    limit: 7,
    follow: true,
  });
  assert.equal(followed.offset, 0);
  assert.equal(followed.content, 'current');
  const rest = await service.log(1, {
    offset: followed.nextOffset,
    cursor: followed.cursor,
    previousPath: followed.logPath,
  });
  assert.equal(rest.reset, false);
  assert.equal(followed.content + rest.content, 'current example');

  service.getDb = async () => ({
    status: 3,
    queued_token: 'new-run',
    log_path: 'current.log',
  });
  const queued = await service.log(1, { follow: true, tail: true });
  assert.equal(queued.status, 'running');
  assert.equal(queued.nextOffset, 0);
  assert.equal(queued.logPath, undefined);
  assert.equal(queued.content, '');
});
