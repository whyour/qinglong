require('reflect-metadata');
require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const environment = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-token-env-'));
fs.writeFileSync(path.join(environment, '.env'), '');
fs.mkdirSync(path.join(environment, 'data/db'), { recursive: true });
process.env.QL_DIR = environment;
process.env.QL_DATA_DIR = path.join(environment, 'data');
require('node:test').after(async () => {
  await require('../../back/shared/store').keyvStore.disconnect();
  await require('../../back/data').sequelize.close();
  fs.rmSync(environment, { recursive: true, force: true });
});
const OpenService = require('../../back/services/open').default;
const { AppModel } = require('../../back/data/open');
const { shareStore } = require('../../back/shared/store');
const config = require('../../back/config').default;

const DAY = 86400;
const START = 1787004000;
const execute = promisify(execFile);

function fixture(t, initialTokens = []) {
  const previousConfigPath = config.configPath;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-token-renewal-'));
  config.configPath = directory;
  t.after(() => {
    config.configPath = previousConfigPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = START;
  let app = {
    name: 'system', client_id: 'system-client', client_secret: 'system-secret',
    scopes: ['crons', 'system', 'dashboard'], tokens: initialTokens,
  };
  t.mock.method(Date, 'now', () => now * 1000);
  t.mock.method(shareStore, 'getApps', async () => [app]);
  t.mock.method(shareStore, 'updateApps', async (apps) => { [app] = apps; });
  t.mock.method(AppModel, 'findOne', async ({ where }) => {
    if (where.name) assert.equal(where.name, app.name);
    else {
      assert.equal(where.client_id, app.client_id);
      assert.equal(where.client_secret, app.client_secret);
    }
    return { tokens: app.tokens, get: () => app };
  });
  t.mock.method(AppModel, 'update', async ({ tokens }) => {
    app = { ...app, tokens };
    return [1];
  });
  t.mock.method(AppModel, 'findAll', async () => [{ get: () => app }]);
  return {
    service: new OpenService({}),
    atDay(day) { now = START + day * DAY; },
    tokens() { return app.tokens; },
  };
}

test('28-day token generation renews ahead of the 30-day expiry', async (t) => {
  const state = fixture(t);
  const initial = await state.service.generateSystemToken();
  assert.equal(initial.expiration, START + 30 * DAY);
  state.atDay(28);
  const renewed = await state.service.generateSystemToken(true);
  assert.equal(renewed.expiration, START + 58 * DAY);
  assert.notEqual(renewed.value, initial.value);
  assert.ok(state.tokens().some((token) => token.value === initial.value));
  state.atDay(56);
  const next = await state.service.generateSystemToken(true);
  assert.equal(next.expiration, START + 86 * DAY);
  assert.ok(state.tokens().some((token) => token.value === renewed.value));
  assert.ok(!state.tokens().some((token) => token.value === initial.value));
});

test('startup generation renews before a restarted 28-day interval', async (t) => {
  const state = fixture(t);
  await state.service.generateSystemToken();
  state.atDay(20);
  const restarted = await state.service.generateSystemToken(true);
  assert.equal(restarted.expiration, START + 50 * DAY);
  state.atDay(48);
  const renewed = await state.service.generateSystemToken(true);
  assert.equal(renewed.expiration, START + 78 * DAY);
  assert.ok(state.tokens().some((token) => token.value === restarted.value));
});

test('generation at the five-token limit extends the reused token without revoking active tokens', async (t) => {
  const initial = Array.from({ length: 5 }, (_, index) => ({
    value: `token-${index}`, expiration: START + 2 * DAY,
  }));
  const state = fixture(t, initial);
  const renewed = await state.service.generateSystemToken(true);
  assert.equal(renewed.value, 'token-4');
  assert.equal(renewed.expiration, START + 30 * DAY);
  assert.equal(state.tokens().length, 5);
  for (const token of initial) {
    assert.ok(state.tokens().some((current) => current.value === token.value));
  }
});

test('ordinary acquisition reuses the newest valid database token and republishes its cache', async (t) => {
  const initial = [
    { value: 'older-token', expiration: START + DAY },
    { value: 'newer-token', expiration: START + 20 * DAY },
  ];
  const state = fixture(t, initial);
  // A stale process cache must not override the token chosen from the database.
  shareStore.getApps = async () => [{ name: 'system', tokens: [] }];
  const token = await state.service.generateSystemToken();
  assert.equal(token.value, 'newer-token');
  assert.deepEqual(state.tokens(), initial);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(config.configPath, 'token.json'), 'utf8')),
    token,
  );
});

test('a failed generation releases its lock and does not publish a token', async (t) => {
  const state = fixture(t);
  const update = AppModel.update;
  AppModel.update = async () => { throw new Error('generation failed'); };
  await assert.rejects(state.service.generateSystemToken(), /generation failed/);
  assert.equal(fs.existsSync(path.join(config.configPath, 'token.json')), false);
  assert.equal(fs.existsSync(path.join(config.configPath, 'token.json.refresh.lock')), false);
  AppModel.update = update;
  const token = await state.service.generateSystemToken();
  assert.ok(state.tokens().some((current) => current.value === token.value));
});

test('acquisition recovers an authentication cache failure after the database commit', async (t) => {
  const state = fixture(t);
  const updateCache = shareStore.updateApps;
  let attempts = 0;
  shareStore.updateApps = async (apps) => {
    if (++attempts === 1) throw new Error('authentication cache failed');
    return updateCache(apps);
  };
  await assert.rejects(state.service.generateSystemToken(), /authentication cache failed/);
  assert.equal(fs.existsSync(path.join(config.configPath, 'token.json')), false);
  const committed = state.tokens()[0];
  const token = await state.service.generateSystemToken();
  assert.equal(token.value, committed.value);
  assert.equal(state.tokens().length, 1);
  assert.equal(attempts, 2);
});

async function processFixture(t, initialTokens = []) {
  const root = path.resolve(__dirname, '../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-token-process-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databaseFile = path.join(directory, 'database.json');
  fs.writeFileSync(databaseFile, JSON.stringify({
    name: 'system', client_id: 'system-client', client_secret: 'system-secret',
    scopes: ['crons', 'system', 'dashboard'], tokens: initialTokens,
  }));
  const worker = path.join(directory, 'worker.cjs');
  fs.writeFileSync(worker, `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const root = process.cwd();
    const directory = __dirname;
    const config = require(path.join(root, 'back/config')).default;
    const { AppModel } = require(path.join(root, 'back/data/open'));
    const { shareStore } = require(path.join(root, 'back/shared/store'));
    config.configPath = directory;
    const databaseFile = path.join(directory, 'database.json');
    const read = async () => JSON.parse(await fs.readFile(databaseFile, 'utf8'));
    AppModel.findOne = async () => {
      if (process.env.QL_TOKEN_TEST_HOLD === '1') {
        await fs.writeFile(path.join(directory, 'locked'), 'ready');
        await new Promise(() => setInterval(() => {}, 1000));
      }
      const app = await read();
      // Widen the read/write overlap so the original race is reproducible.
      await new Promise(resolve => setTimeout(resolve, 75));
      return { ...app, get: () => app };
    };
    AppModel.update = async ({ tokens }) => {
      if (process.env.QL_TOKEN_TEST_FAIL === '1') throw new Error('generation failed');
      const app = await read();
      await fs.writeFile(databaseFile, JSON.stringify({ ...app, tokens }));
      return [1];
    };
    AppModel.findAll = async () => {
      const app = await read();
      return [{ get: () => app }];
    };
    shareStore.getApps = async () => { throw new Error('stale cache must not be read'); };
    shareStore.updateApps = async () => {};
    require(path.join(root, 'back/token'));
  `);
  return {
    directory,
    run(renew = false, fail = false, hold = false) {
      return execute(process.execPath, [
        '-r', require.resolve('ts-node/register/transpile-only'), worker,
        ...(renew ? ['--renew'] : []),
      ], {
        cwd: root, timeout: 20_000,
        env: { ...process.env, QL_TOKEN_TEST_FAIL: fail ? '1' : '0', QL_TOKEN_TEST_HOLD: hold ? '1' : '0' },
      });
    },
    tokens() { return JSON.parse(fs.readFileSync(databaseFile, 'utf8')).tokens; },
    cached() { return JSON.parse(fs.readFileSync(path.join(directory, 'token.json'), 'utf8')); },
  };
}

test('four independent token processes converge on one usable token when the cache is missing', async (t) => {
  const state = await processFixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => state.run()));
  const issued = results.map(({ stdout, stderr }) => {
    assert.equal(stderr, '');
    return stdout.trim();
  });
  assert.equal(new Set(issued).size, 1);
  assert.equal(state.tokens().length, 1);
  assert.equal(state.tokens()[0].value, issued[0]);
  assert.equal(state.cached().value, issued[0]);
  assert.equal(fs.existsSync(path.join(state.directory, 'token.json.refresh.lock')), false);
});

test('concurrent scheduled renewal and ordinary acquisition preserve all returned tokens', async (t) => {
  const original = { value: 'original-token', expiration: Math.round(Date.now() / 1000) + DAY };
  const state = await processFixture(t, [original]);
  const results = await Promise.all([state.run(true), state.run(), state.run(true), state.run()]);
  const tokens = state.tokens();
  assert.equal(tokens.length, 3);
  assert.ok(tokens.some((token) => token.value === original.value));
  for (const { stdout, stderr } of results) {
    assert.equal(stderr, '');
    assert.ok(tokens.some((token) => token.value === stdout.trim()));
  }
  assert.ok(tokens.some((token) => token.value === state.cached().value));
});

test('token CLI reports generation failure on stderr with a nonzero exit code', async (t) => {
  const state = await processFixture(t);
  await assert.rejects(state.run(false, true), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /generation failed/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(state.directory, 'token.json')), false);
  const recovered = await state.run();
  assert.equal(recovered.stdout.trim(), state.cached().value);
});

test('startup configures the 28-day token task with explicit renewal', async (t) => {
  const { Container } = require('typedi');
  const initialize = require('../../back/loaders/initTask').default;
  const SystemService = require('../../back/services/system').default;
  const ScheduleService = require('../../back/services/schedule').default;
  const SubscriptionService = require('../../back/services/subscription').default;
  const SshKeyService = require('../../back/services/sshKey').default;
  const scheduled = [];
  const services = new Map([
    [SystemService, { getSystemConfig: async () => undefined }],
    [ScheduleService, {
      cancelIntervalTask: async () => {},
      createIntervalTask: (...args) => scheduled.push(args),
    }],
    [SubscriptionService, { setSshConfig: async () => {}, list: async () => [] }],
    [SshKeyService, {}],
  ]);
  t.mock.method(Container, 'get', (service) => {
    assert.ok(services.has(service));
    return services.get(service);
  });
  await initialize();
  assert.equal(scheduled.length, 1);
  const [task, interval, immediate] = scheduled[0];
  assert.match(task.command, /(?:token\.ts|token\.js) --renew$/);
  assert.equal(task.runOrigin, 'system');
  assert.deepEqual(interval, { days: 28 });
  assert.equal(immediate, true);
});

function appsFixture(t) {
  const previousConfigPath = config.configPath;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-apps-concurrency-'));
  config.configPath = directory;
  t.after(() => {
    config.configPath = previousConfigPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => START * 1000);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let apps = [
    { id: 1, name: 'system', client_id: 'system-client', client_secret: 'system-secret',
      scopes: ['crons', 'system', 'dashboard'], tokens: [{ value: 'system-token', expiration: START + DAY }] },
    { id: 2, name: 'external', client_id: 'external-client', client_secret: 'external-secret',
      scopes: ['crons'], tokens: [] },
  ];
  let cached = clone(apps);
  const matches = (app, where) => Object.entries(where).every(([key, value]) =>
    Array.isArray(value) ? value.includes(app[key]) : app[key] === value);
  t.mock.method(AppModel, 'findOne', async ({ where }) => {
    const app = apps.find((app) => matches(app, where));
    if (!app) return null;
    const snapshot = clone(app);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ...snapshot, get: () => snapshot };
  });
  t.mock.method(AppModel, 'findAll', async () => clone(apps).map((app) => ({ get: () => app })));
  t.mock.method(AppModel, 'update', async (values, { where }) => {
    apps = apps.map((app) => matches(app, where) ? { ...app, ...clone(values) } : app);
    return [1];
  });
  t.mock.method(AppModel, 'destroy', async ({ where }) => {
    apps = apps.filter((app) => !matches(app, where));
  });
  t.mock.method(AppModel, 'create', async (values) => {
    const app = { id: Math.max(0, ...apps.map((app) => app.id)) + 1, tokens: [], ...values };
    apps.push(app);
    return { get: () => clone(app) };
  });
  t.mock.method(shareStore, 'updateApps', async (values) => { cached = clone(values); });
  t.mock.method(shareStore, 'getApps', async () => clone(cached));
  return { service: new OpenService({}), apps: () => clone(apps), cached: () => clone(cached) };
}

for (const operation of ['acquisition', 'startup refresh']) {
  test(`${operation} cannot overwrite another application's newly issued token`, async (t) => {
    const state = appsFixture(t);
    let resume;
    let entered;
    const paused = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { resume = resolve; });
    const findAll = AppModel.findAll;
    let first = true;
    AppModel.findAll = async (...args) => {
      const snapshot = await findAll(...args);
      if (first) {
        first = false;
        entered();
        await barrier;
      }
      return snapshot;
    };
    const publication = operation === 'acquisition'
      ? state.service.generateSystemToken() : state.service.refreshApps();
    await paused;
    const issuance = state.service.authToken({ client_id: 'external-client', client_secret: 'external-secret' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    resume();
    const [, response] = await Promise.all([publication, issuance]);
    assert.equal(response.code, 200);
    assert.ok(state.apps()[1].tokens.some((token) => token.value === response.data.token));
    assert.deepEqual(state.cached(), state.apps());
  });
}

test('concurrent token API calls and scheduled generation preserve every issued token', async (t) => {
  const state = appsFixture(t);
  const credentials = { client_id: 'system-client', client_secret: 'system-secret' };
  const results = await Promise.all([
    state.service.authToken(credentials), state.service.generateSystemToken(true),
    state.service.authToken(credentials), state.service.generateSystemToken(true),
  ]);
  const tokens = state.apps()[0].tokens;
  assert.equal(tokens.length, 5);
  for (const response of results) {
    assert.ok(tokens.some((token) => token.value === (response.value || response.data.token)));
  }
  assert.deepEqual(state.cached(), state.apps());
});

for (const mutation of ['resetSecret', 'remove', 'update', 'create']) {
  test(`concurrent cache refresh and ${mutation} retain the latest application state`, async (t) => {
    const state = appsFixture(t);
    await state.service.authToken({ client_id: 'external-client', client_secret: 'external-secret' });
    const change = () => mutation === 'resetSecret' ? state.service.resetSecret(2)
      : mutation === 'remove' ? state.service.remove([2])
      : mutation === 'update' ? state.service.update({ id: 2, name: 'external', scopes: ['dashboard'] })
      : state.service.create({ name: 'created', scopes: ['crons'] });
    await Promise.all([state.service.refreshApps(), change(), state.service.generateSystemToken()]);
    assert.deepEqual(state.cached(), state.apps());
    if (mutation === 'resetSecret') {
      assert.equal(state.cached()[1].tokens.length, 0);
      assert.notEqual(state.cached()[1].client_secret, 'external-secret');
      assert.equal((await state.service.authToken({ client_id: 'external-client', client_secret: 'external-secret' })).code, 400);
    } else if (mutation === 'remove') {
      assert.equal(state.cached().length, 1);
    } else if (mutation === 'update') {
      assert.deepEqual(state.cached()[1].scopes, ['dashboard']);
    } else {
      assert.equal(state.cached().length, 3);
    }
  });
}

test('system initialization preserves active tokens while migrating dashboard scope', async (t) => {
  const state = appsFixture(t);
  await AppModel.update({ scopes: ['crons', 'system'] }, { where: { id: 1 } });
  await Promise.all([state.service.initializeSystemApp(), state.service.generateSystemToken(true)]);
  assert.deepEqual(state.cached(), state.apps());
  assert.deepEqual(state.apps()[0].scopes, ['crons', 'system', 'dashboard']);
  assert.equal(state.apps()[0].tokens.length, 2);
});

test('failed atomic token-file publication releases the application lock for recovery', async (t) => {
  const state = appsFixture(t);
  const temporary = path.join(config.configPath, `token.json.${process.pid}.tmp`);
  fs.mkdirSync(temporary);
  await assert.rejects(state.service.generateSystemToken(), /EISDIR/);
  fs.rmSync(temporary, { recursive: true });
  const token = await state.service.generateSystemToken();
  assert.equal(token.value, 'system-token');
  assert.equal(fs.existsSync(path.join(config.configPath, '.apps-state.lock')), false);
});

test('real SQLite and authentication cache retain concurrent process updates', async (t) => {
  fs.mkdirSync(config.configPath, { recursive: true });
  await AppModel.sync({ force: true });
  const service = new OpenService({});
  await service.initializeSystemApp();
  const external = await service.create({ name: 'sqlite-external', scopes: ['crons'] });
  const worker = path.join(environment, 'sqlite-worker.cjs');
  const root = path.resolve(__dirname, '../..');
  fs.writeFileSync(worker, `
    require(${JSON.stringify(require.resolve('reflect-metadata'))});
    const path = require('node:path');
    const root = process.cwd();
    const OpenService = require(path.join(root, 'back/services/open')).default;
    const { shareStore, keyvStore } = require(path.join(root, 'back/shared/store'));
    const { sequelize } = require(path.join(root, 'back/data'));
    const service = new OpenService({});
    (async () => {
      const action = process.argv[2];
      const result = action === 'auth'
        ? await service.authToken({ client_id: process.argv[3], client_secret: process.argv[4] })
        : action === 'refresh' ? await service.refreshApps()
        : await service.generateSystemToken(action === 'renew');
      console.log(JSON.stringify(result || {}));
    })().catch(error => { console.error(error); process.exitCode = 1; })
      .finally(async () => { await keyvStore.disconnect(); await sequelize.close(); });
  `);
  const actions = ['renew', 'acquire', 'auth', 'refresh', 'renew', 'auth', 'auth'];
  const outcomes = await Promise.allSettled(actions.map((action) => execute(process.execPath, [
    '-r', require.resolve('ts-node/register/transpile-only'), worker, action,
    external.client_id, external.client_secret,
  ], { cwd: root, timeout: 20_000, env: process.env })));
  const results = outcomes.map((outcome) => {
    assert.equal(outcome.status, 'fulfilled', outcome.reason?.stderr);
    return outcome.value;
  });
  const database = await service.findApps();
  const cached = await shareStore.getApps();
  assert.deepEqual(cached, JSON.parse(JSON.stringify(database)));
  for (let index = 0; index < results.length; index++) {
    assert.equal(results[index].stderr, '');
    const result = JSON.parse(results[index].stdout.trim());
    const value = result.value || result.data?.token;
    if (value) assert.ok(cached.some((app) => app.tokens?.some((token) => token.value === value)));
  }
  assert.equal(database.find((app) => app.name === 'sqlite-external').tokens.length, 3);
  const file = JSON.parse(fs.readFileSync(path.join(config.configPath, 'token.json'), 'utf8'));
  assert.ok(cached.find((app) => app.name === 'system').tokens.some((token) => token.value === file.value));
});


test('atomic publication preserves restricted token-file permissions', async (t) => {
  const state = fixture(t, [{ value: 'current', expiration: START + DAY }]);
  const file = path.join(config.configPath, 'token.json');
  await state.service.generateSystemToken();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o640);
  await state.service.generateSystemToken(true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});


test('a SIGKILLed generator leaves a lock that the next acquisition recovers', async (t) => {
  const state = await processFixture(t);
  const running = state.run(false, false, true);
  const stopped = running.catch((error) => error);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(state.directory, 'locked'))) {
    assert.ok(Date.now() < deadline, 'generator did not acquire the lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  running.child.kill('SIGKILL');
  assert.equal((await stopped).signal, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(state.directory, '.apps-state.lock')), true);
  const recovered = await state.run();
  assert.equal(recovered.stderr, '');
  assert.equal(recovered.stdout.trim(), state.cached().value);
  assert.equal(fs.existsSync(path.join(state.directory, '.apps-state.lock')), false);
});
