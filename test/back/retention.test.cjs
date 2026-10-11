const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Op } = require('sequelize');

const {
  getDirectorySize,
  normalizeRetentionPolicy,
} = require('../../back/shared/retention');

test('retention policy defaults to disabled and clamps invalid values', () => {
  assert.deepEqual(normalizeRetentionPolicy({}), {
    runningInstanceRetentionDays: 0,
    cronStatRetentionDays: 0,
  });
  assert.deepEqual(
    normalizeRetentionPolicy({
      runningInstanceRetentionDays: -10,
      cronStatRetentionDays: 99999,
    }),
    {
      runningInstanceRetentionDays: 0,
      cronStatRetentionDays: 3650,
    },
  );
});

test('directory preview counts files recursively and ignores symlinks', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-retention-'));
  const nested = path.join(directory, 'nested');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(nested);
  await fs.writeFile(path.join(directory, 'one'), Buffer.alloc(7));
  await fs.writeFile(path.join(nested, 'two'), Buffer.alloc(11));
  await fs.symlink(path.join(nested, 'two'), path.join(directory, 'link'));

  assert.equal(await getDirectorySize(directory), 18);
  assert.equal(await getDirectorySize(path.join(directory, 'missing')), 0);
});

test('cleanup previews first, protects running instances, and uses explicit options', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-retention-'));
  const nodeCache = path.join(directory, 'node');
  await fs.mkdir(nodeCache);
  await fs.writeFile(path.join(nodeCache, 'cache'), Buffer.alloc(13));

  const config = require('../../back/config').default;
  const originalCachePath = config.dependenceCachePath;
  const RunningInstanceModel = {};
  const CrontabStatModel = {};
  const InstanceStatus = { running: 0 };
  const sequelize = {};
  const stubModule = (modulePath, exports) => {
    require.cache[require.resolve(modulePath)] = {
      id: require.resolve(modulePath),
      filename: require.resolve(modulePath),
      loaded: true,
      exports,
      children: [],
      paths: [],
    };
  };
  stubModule('../../back/data', { sequelize });
  stubModule('../../back/data/cronStats', { CrontabStatModel });
  stubModule('../../back/data/runningInstance', {
    InstanceStatus,
    RunningInstanceModel,
  });
  stubModule('../../back/data/system', {
    AuthDataType: { systemConfig: 'systemConfig' },
    SystemModel: {},
  });
  delete require.cache[require.resolve('../../back/services/retention')];
  const RetentionService = require('../../back/services/retention').default;

  t.after(async () => {
    config.dependenceCachePath = originalCachePath;
    await fs.rm(directory, { recursive: true, force: true });
  });

  let instanceWhere;
  let vacuumed = false;
  let instanceCountCalls = 0;
  let statCountCalls = 0;
  config.dependenceCachePath = directory;
  RunningInstanceModel.count = async ({ where }) => {
    instanceCountCalls++;
    instanceWhere = where;
    return 2;
  };
  RunningInstanceModel.destroy = async ({ where }) => {
    instanceWhere = where;
    return 2;
  };
  CrontabStatModel.count = async () => {
    statCountCalls++;
    return 3;
  };
  CrontabStatModel.destroy = async () => 3;
  sequelize.transaction = async (callback) => callback({});
  sequelize.query = async (query) => {
    vacuumed = query === 'VACUUM';
    return [];
  };

  const service = new RetentionService();
  const disabledPreview = await service.preview({
    runningInstanceRetentionDays: 0,
    cronStatRetentionDays: 0,
  });
  assert.equal(disabledPreview.runningInstances, 0);
  assert.equal(disabledPreview.cronStats, 0);
  assert.equal(instanceCountCalls, 0);
  assert.equal(statCountCalls, 0);

  const result = await service.cleanup({
    runningInstanceRetentionDays: 30,
    cronStatRetentionDays: 90,
    dependenceCacheTypes: ['node'],
    compactDatabase: true,
  });

  assert.equal(instanceWhere.status[Op.ne], InstanceStatus.running);
  assert.equal(result.deleted.runningInstances, 2);
  assert.equal(result.deleted.cronStats, 3);
  assert.equal(result.deleted.dependenceCacheBytes, 13);
  assert.equal(vacuumed, true);
  await assert.rejects(fs.stat(nodeCache), { code: 'ENOENT' });
});
