const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const {
  Sequelize,
  DataTypes,
  Op,
  QueryTypes,
  where,
  col,
} = require('sequelize');
const { DatabaseClient } = require('../../back/data/databaseClient');
const { Repository } = require('../../back/data/repository');
const { initialize } = require('../helpers/repository-fixture.cjs');
const names = {
  App: 'Apps',
  Auth: 'Auths',
  Crontab: 'Crontabs',
  CrontabStat: 'CrontabStats',
  CrontabView: 'CrontabViews',
  Dependence: 'Dependences',
  Env: 'Envs',
  RunningInstance: 'RunningInstances',
  Subscription: 'Subscriptions',
};
async function legacy(file) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: file,
    logging: false,
  });
  const models = {};
  for (const [name, tableName] of Object.entries(names)) {
    const columns = await database.query(`PRAGMA table_info("${tableName}")`, {
      type: QueryTypes.SELECT,
    });
    const attrs = Object.fromEntries(
      columns.map((c) => [
        c.name,
        {
          type:
            c.type === 'JSON'
              ? DataTypes.JSON
              : c.type === 'DATETIME'
              ? DataTypes.DATE
              : c.type === 'TINYINT(1)'
              ? DataTypes.BOOLEAN
              : /INT|NUMBER/.test(c.type)
              ? DataTypes.NUMBER
              : DataTypes.STRING,
          ...(c.pk ? { primaryKey: true, autoIncrement: true } : {}),
        },
      ]),
    );
    models[name] = database.define(name, attrs, {
      tableName,
      freezeTableName: true,
    });
  }
  return { database, models };
}

test('all nine legacy tables remain readable in both versions without changing schema, IDs, dates or .env', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-orm-legacy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'database.sqlite'),
    envFile = path.join(dir, '.env');
  const environment = 'QL_DATA_DIR=/synthetic/old-data\nSYNTHETIC_ENV=keep\n';
  await fs.writeFile(envFile, environment);
  const seed = new Sequelize({
    dialect: 'sqlite',
    storage: file,
    logging: false,
  });
  try {
    const sql = await fs.readFile(
      path.resolve('test/fixtures/sequelize-2.23-schema.sql'),
      'utf8',
    );
    for (const statement of sql
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean))
      await seed.query(statement);
  } finally {
    await seed.close();
  }
  let old = await legacy(file);
  const payloads = {
    App: { name: 'legacy', scopes: ['envs'], client_id: 'synthetic-client' },
    Auth: {
      type: 'authConfig',
      info: {
        username: 'synthetic-user',
        password: 'synthetic-hash',
        tokens: { desktop: ['keep'] },
      },
    },
    Crontab: {
      name: 'legacy',
      command: 'echo synthetic',
      schedule: '0 0 * * *',
      saved: true,
      labels: ['中文'],
    },
    CrontabStat: { ref_id: 7, date: '2026-10-21', run_count: 2 },
    CrontabView: {
      name: 'legacy',
      filters: [{ property: 'status', operation: 'In', value: [1] }],
    },
    Dependence: { name: 'legacy', type: 0, log: ['旧日志'] },
    Env: {
      name: 'legacy',
      value: '旧值',
      labels: ['中文'],
      position: 4500000000000000,
    },
    RunningInstance: { cron_id: 7, started_at: 100, status: 2, exit_code: 143 },
    Subscription: {
      name: 'legacy',
      alias: 'legacy',
      pull_option: { username: 'synthetic', password: 'synthetic-only' },
    },
  };
  const date = new Date('2020-01-02T03:04:05.006Z');
  for (const [name, payload] of Object.entries(payloads))
    await old.models[name].create({
      id: 7,
      ...payload,
      createdAt: date,
      updatedAt: date,
    });
  const schema = await old.database.query(
    "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    { type: QueryTypes.SELECT },
  );
  await old.database.close();
  const client = new DatabaseClient(file);
  t.after(() => client.close());
  await initialize(client);
  for (const [name, payload] of Object.entries(payloads)) {
    const repository = new Repository(name, () => client),
      row = await repository.findOne({ id: 7 });
    for (const [field, value] of Object.entries(payload))
      assert.deepEqual(row[field], value, `${name}.${field}`);
    assert.equal(row.createdAt.toISOString(), date.toISOString());
    const added = await repository.insert({
      ...payload,
      id: undefined,
      ...(payload.name ? { name: 'new' } : {}),
      ...(payload.alias ? { alias: 'new' } : {}),
      ...(payload.date ? { date: '2026-10-22' } : {}),
    });
    assert(added.id > 7, name);
    assert(added.createdAt instanceof Date);
  }
  assert.deepEqual(
    await client.query(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    ),
    schema,
  );
  await client.close();
  old = await legacy(file);
  try {
    for (const name of Object.keys(payloads)) {
      const rows = await old.models[name].findAll({ order: [['id', 'ASC']] });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].createdAt.toISOString(), date.toISOString());
      assert(rows[1].createdAt instanceof Date);
      assert(!Number.isNaN(+rows[1].createdAt));
    }
    assert.equal(await fs.readFile(envFile, 'utf8'), environment);
  } finally {
    await old.database.close();
  }
});

test('native filters retain legacy NULL, IN, nested groups and JSON text matching', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-orm-filters-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'database.sqlite');
  const client = new DatabaseClient(file);
  t.after(() => client.close());
  await initialize(client);
  const repository = new Repository('Env', () => client);
  for (const row of [
    { name: 'one', value: 'a', status: 0, labels: ['中文', 'keep'] },
    { name: 'two', value: 'b', status: 1, labels: [] },
    { name: null, value: 'c', status: 0, labels: null },
  ])
    await repository.insert(row);
  const old = await legacy(file);
  t.after(() => old.database.close());
  const cases = [
    [{ status: [0, 1] }, { status: [0, 1] }],
    [{ name: { [Op.not]: null } }, { name: { $ne: null } }],
    [
      { [Op.or]: [{ name: 'missing' }, {}] },
      { $or: [{ name: 'missing' }, {}] },
    ],
    [{ [Op.and]: [{ status: 0 }, {}] }, { $and: [{ status: 0 }, {}] }],
    [{ [Op.or]: [] }, { $or: [] }],
    [
      where(col('labels'), { [Op.like]: '%keep%' }),
      { labels: { $like: '%keep%' } },
    ],
    [{ name: { [Op.notIn]: ['one'] } }, { name: { $nin: ['one'] } }],
  ];
  for (const [before, after] of cases) {
    const expected = (
      await old.models.Env.findAll({ where: before, order: [['id', 'ASC']] })
    ).map((x) => x.id);
    const actual = (
      await repository.find(after, { orderBy: [{ id: 'asc' }] })
    ).map((x) => x.id);
    assert.deepEqual(actual, expected, JSON.stringify(after));
  }
});
