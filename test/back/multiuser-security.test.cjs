const test = require('node:test'),
  assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const jwt = require('jsonwebtoken'),
  express = require('express');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const load = require('../helpers/load-security-module.cjs');

test('user accounts keep credentials private, update on SQLite and revoke changed sessions', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  const cache = new Map();
  const config = {
    jwt: { secret: 'synthetic-multiuser-test' },
    api: { prefix: '/api' },
  };
  const mocks = {
    '.': { sequelize: database },
    '../config': config,
    '../shared/store': {
      shareStore: { getAuthInfo: async () => ({ username: 'owner' }) },
    },
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
  };
  const { UserModel } = load('back/data/user.ts', mocks, cache);
  await UserModel.sync();
  const Account = load('back/services/userManagement.ts', mocks, cache).default;
  const account = new Account({});
  const alice = await account.create({
    username: 'alice',
    password: 'password1',
    role: 1,
    status: 0,
  });
  assert.ok(!Object.hasOwn(alice, 'password'));
  assert.ok(!Object.hasOwn(alice, 'sessions'));
  const admin = await account.create({
    username: 'manager',
    password: 'password2',
    role: 0,
    status: 0,
  });
  assert.equal(admin.role, 0);
  const raw = await UserModel.findByPk(alice.id);
  assert.match(raw.password, /^scrypt\$/);
  assert.notEqual(raw.password, 'password1');
  assert.equal(await account.authenticate('alice', 'wrong'), null);
  let token = await account.issueToken(
    await account.authenticate('alice', 'password1'),
    'desktop',
  );
  assert.equal((await account.validateToken(token, 'desktop')).id, alice.id);
  assert.equal(await account.validateToken(token, 'mobile'), null);
  const forged = jwt.sign({ userId: alice.id, role: 0 }, config.jwt.secret, {
    algorithm: 'HS384',
    expiresIn: '1h',
  });
  assert.equal(await account.validateToken(forged, 'desktop'), null);
  const updated = await account.update({
    id: alice.id,
    username: 'alice',
    password: '',
  });
  assert.equal(updated.username, 'alice');
  assert.ok(!Object.hasOwn(updated, 'password'));
  assert.equal(await account.validateToken(token, 'desktop'), null);
  token = await account.issueToken(
    await account.authenticate('alice', 'password1'),
    'desktop',
  );
  await account.revokeToken(alice.id, token);
  assert.equal(await account.validateToken(token, 'desktop'), null);
  token = await account.issueToken(
    await account.authenticate('alice', 'password1'),
    'desktop',
  );
  await account.update({ id: alice.id, status: 1 });
  assert.equal(await account.validateToken(token, 'desktop'), null);
  assert.equal(await account.authenticate('alice', 'password1'), null);
  assert.ok(
    (await account.list()).every(
      (x) => !Object.hasOwn(x, 'password') && !Object.hasOwn(x, 'sessions'),
    ),
  );
  await assert.rejects(
    account.create({
      username: 'owner',
      password: 'password3',
      role: 1,
      status: 0,
    }),
  );
  await account.update({ id: alice.id, status: 0, password: 'changed123' });
  assert.equal(await account.authenticate('alice', 'password1'), null);
  await account.delete([alice.id]);
  assert.equal(await account.validateToken(token, 'desktop'), null);
});

test('HTTP ordinary users see only their own data and cannot invoke global or executable APIs', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  const cache = new Map();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-user-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = 'synthetic-http-multiuser',
    adminToken = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: '1h' });
  const config = {
    jwt: { secret },
    api: { prefix: '/api' },
    apiWhiteList: ['/api/user/login', '/api/health', '/api/system'],
    baseUrl: '',
    rootPath: root,
    uploadPath: root,
  };
  const mocks = {
    '.': { sequelize: database },
    '../config': config,
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
    '../shared/i18n': { t: (x) => x },
    '../data/open': {},
    '../config/serverEnv': { serveEnv: (req, res) => res.end() },
    '../config/util': {
      getToken: (req) =>
        (req.headers.authorization || '').replace(/^Bearer /, ''),
      getPlatform: () => 'desktop',
    },
    '../shared/store': {
      shareStore: {
        getAuthInfo: async () => ({
          username: 'owner',
          password: 'configured',
          token: adminToken,
        }),
        getApps: async () => [],
      },
    },
  };
  const userData = load('back/data/user.ts', mocks, cache),
    envData = load('back/data/env.ts', mocks, cache),
    cronData = load('back/data/cron.ts', mocks, cache),
    subData = load('back/data/subscription.ts', mocks, cache);
  for (const model of [
    userData.UserModel,
    envData.EnvModel,
    cronData.CrontabModel,
    subData.SubscriptionModel,
  ])
    await model.sync();
  mocks['../data/env'] = envData;
  mocks['../data/cron'] = cronData;
  mocks['../data/subscription'] = subData;
  const Account = load('back/services/userManagement.ts', mocks, cache).default;
  const account = new Account({});
  mocks['../services/userManagement'] = { default: Account };
  mocks.typedi.Container = { get: () => account };
  const alice = await account.create({
      username: 'alice',
      password: 'password1',
      role: 1,
      status: 0,
    }),
    bob = await account.create({
      username: 'bob',
      password: 'password2',
      role: 1,
      status: 0,
    });
  await envData.EnvModel.bulkCreate([
    { name: 'mine', value: 'alice-only', userId: alice.id },
    { name: 'other', value: 'bob-secret', userId: bob.id },
    { name: 'legacy', value: 'owner-secret', userId: null },
  ]);
  let commands = 0;
  mocks['../api'] = () => {
    const router = express.Router();
    router.get('/system', (req, res) => res.json({ code: 200 }));
    router.get('/user', async (req, res) =>
      res.json({ code: 200, data: await account.get(req.user.userId) }),
    );
    router.post('/user/logout', async (req, res) => {
      await account.revokeToken(
        req.user.userId,
        mocks['../config/util'].getToken(req),
      );
      res.json({ code: 200 });
    });
    router.post('/system/command', (req, res) => {
      commands++;
      res.json({ code: 200 });
    });
    router.get('/envs', (req, res) =>
      res.json({ code: 200, data: 'admin-all' }),
    );
    return router;
  };
  const app = express();
  load('back/loaders/express.ts', mocks, cache).default({ app });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  let token = await account.issueToken(
    await account.authenticate('alice', 'password1'),
    'desktop',
  );
  async function request(url, method = 'GET', current = token) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${url}`,
      { method, headers: { Authorization: 'Bearer ' + current } },
    );
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/system')).status, 200);
  assert.equal((await request('/api/user')).body.data.username, 'alice');
  const mine = await request(`/api/envs?userId=${bob.id}`);
  assert.deepEqual(
    mine.body.data.map((x) => x.value),
    ['alice-only'],
  );
  assert.equal((await request('/api/envs/2')).status, 404);
  assert.equal((await request('/api/envs/3')).status, 404);
  for (const [url, method] of [
    ['/api/system/command', 'POST'],
    ['/api/crons/run', 'PUT'],
    ['/api/envs', 'PUT'],
    ['/api/configs', 'GET'],
    ['/api/logs', 'GET'],
    ['/api/scripts', 'GET'],
    ['/api/dependencies', 'POST'],
    ['/api/user-management', 'GET'],
    ['/api/system/config', 'GET'],
    ['/api/user/two-factor/init', 'GET'],
  ])
    assert.equal((await request(url, method)).status, 403, url);
  assert.equal(commands, 0);
  assert.equal(
    (await request('/api/envs', 'GET', adminToken)).body.data,
    'admin-all',
  );
  const forged = jwt.sign({ userId: alice.id, role: 0 }, secret, {
    algorithm: 'HS384',
    expiresIn: '1h',
  });
  assert.equal((await request('/api/envs', 'GET', forged)).status, 401);
  await request('/api/user/logout', 'POST');
  assert.equal((await request('/api/envs')).status, 401);
  token = await account.issueToken(
    await account.authenticate('alice', 'password1'),
    'desktop',
  );
  await account.update({ id: alice.id, status: 1 });
  assert.equal((await request('/api/envs')).status, 401);
});

test('user ownership migration preserves existing records and is idempotent', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  for (const table of [
    'Users',
    'Envs',
    'Crontabs',
    'Subscriptions',
    'Dependences',
  ])
    await database.query(
      `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, name TEXT)`,
    );
  await database.query(`INSERT INTO Envs (id,name) VALUES (1,'preserved')`);
  const {
    migrateUserSchema,
  } = require('../../back/shared/userSchemaMigrations');
  await migrateUserSchema(database);
  await migrateUserSchema(database);
  const [rows] = await database.query('SELECT * FROM Envs');
  assert.equal(rows[0].name, 'preserved');
  assert.equal(rows[0].userId, null);
  const columns = await database.getQueryInterface().describeTable('Users');
  assert.ok(columns.sessions);
});
