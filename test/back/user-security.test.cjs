const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { authenticator } = require('@otplib/preset-default');
const load = require('../helpers/load-security-module.cjs');
const { verifyPassword, isPasswordHash } = load(
  path.join(__dirname, '../../back/shared/password.ts'),
);
const req = {
  platform: 'desktop',
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
};

function fixture(initial) {
  let auth = structuredClone(initial);
  let closed = 0;
  const model = {
    findOne: async () => ({ id: 1 }),
    update: async () => [1, [{}]],
    create: async (x) => x,
    findAll: async () => [],
    destroy: async () => {},
  };
  const mocks = {
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
    '../config': { jwt: { secret: 'test-secret' }, maxTokensPerPlatform: 10 },
    '../data/system': {
      AuthDataType: { authConfig: 'authConfig', loginLog: 'loginLog' },
      LoginStatus: { fail: 0, success: 1 },
      SystemModel: model,
    },
    '../config/util': {
      createRandomString: () =>
        require('node:crypto').randomBytes(32).toString('hex'),
    },
    './notify': class {},
    './schedule': class {},
    './sock': class {},
    '../shared/store': {
      shareStore: {
        getAuthInfo: async () => auth,
        updateAuthInfo: async (x) => {
          auth = x;
        },
      },
    },
    '../shared/i18n': { t: (x) => x, tf: (x, y) => x.replace('%s', y) },
    '../shared/clientIp': {
      getClientIp: () => '127.0.0.1',
      normalizeClientIp: (x) => x,
    },
    ip2region: class {
      search() {
        return null;
      }
    },
  };
  const User = load(
    path.join(__dirname, '../../back/services/user.ts'),
    mocks,
  ).default;
  const user = new User(
    { warn() {}, info() {} },
    {},
    { getClients: () => [{ close: () => closed++ }] },
  );
  user.notificationService = { notify() {} };
  return {
    user,
    get auth() {
      return auth;
    },
    get closed() {
      return closed;
    },
  };
}
const initialized = () => ({
  username: 'owner',
  password: 'old-password',
  token: 'stolen-token',
  tokens: { desktop: [{ value: 'stolen-token' }] },
  retries: 0,
  lastlogon: 0,
});

test('initialization checks state inside a serialized mutation', async () => {
  const f = fixture({ username: 'admin', password: 'admin' });
  assert.equal(
    (await f.user.login({ username: 'admin', password: 'admin' }, req)).code,
    450,
  );
  assert.deepEqual(f.auth, { username: 'admin', password: 'admin' });
  const results = await Promise.all([
    f.user.initializeUser({ username: 'owner', password: 'first-password' }),
    f.user.initializeUser({
      username: 'attacker',
      password: 'second-password',
    }),
  ]);
  assert.deepEqual(
    results.map((x) => x.code),
    [200, 450],
  );
  assert.equal(f.auth.username, 'owner');
  assert.equal(await verifyPassword('first-password', f.auth.password), true);
  assert.equal(
    (
      await f.user.initializeUser({
        username: 'attacker',
        password: 'third-password',
      })
    ).code,
    450,
  );
});

test('password change revokes sessions and closes connected clients', async () => {
  const f = fixture(initialized());
  await f.user.updateUsernameAndPassword({
    username: 'owner',
    password: 'new-password',
  });
  assert.equal(f.auth.token, '');
  assert.deepEqual(f.auth.tokens, {});
  assert.equal(f.closed, 1);
  assert.equal(await verifyPassword('new-password', f.auth.password), true);
  assert.equal(
    (await f.user.login({ username: 'owner', password: 'old-password' }, req))
      .code,
    400,
  );
  const login = await f.user.login(
    { username: 'owner', password: 'new-password' },
    req,
  );
  assert.equal(login.code, 200);
  jwt.verify(login.data.token, 'test-secret', { algorithms: ['HS384'] });
});

test('a concurrent old-password login cannot restore a session after reset', async () => {
  const f = fixture(initialized());
  const results = await Promise.all([
    f.user.login({ username: 'owner', password: 'old-password' }, req),
    f.user.resetAuthInfo({ password: 'new-password' }),
  ]);
  assert.equal(results[0].code, 200);
  assert.equal(f.auth.token, '');
  assert.deepEqual(f.auth.tokens, {});
  assert.equal(await verifyPassword('new-password', f.auth.password), true);
});

test('legacy plaintext migrates after a successful login', async () => {
  const f = fixture(initialized());
  assert.equal(
    (await f.user.login({ username: 'owner', password: 'old-password' }, req))
      .code,
    200,
  );
  assert.equal(isPasswordHash(f.auth.password), true);
  assert.equal(await verifyPassword('old-password', f.auth.password), true);
});

test('TOTP failures are counted serially and further attempts are throttled', async () => {
  const secret = authenticator.generateSecret();
  const f = fixture({
    ...initialized(),
    twoFactorActivated: true,
    twoFactorSecret: secret,
  });
  assert.equal(
    (await f.user.login({ username: 'owner', password: 'old-password' }, req))
      .code,
    420,
  );
  const badCode =
    authenticator.generate(secret) === '000000' ? '111111' : '000000';
  const results = await Promise.all(
    Array.from({ length: 120 }, () =>
      f.user.twoFactorLogin(
        { username: 'owner', password: 'old-password', code: badCode },
        req,
      ),
    ),
  );
  assert.equal(f.auth.retries, 3);
  assert.equal(results.filter((x) => x.code === 430).length, 3);
  assert.equal(results.filter((x) => x.code === 410).length, 117);
});

test('TOTP challenge expires and valid codes cannot be reused in the same step', async () => {
  const secret = authenticator.generateSecret();
  const f = fixture({
    ...initialized(),
    twoFactorActivated: true,
    twoFactorSecret: secret,
  });
  await f.user.login({ username: 'owner', password: 'old-password' }, req);
  f.auth.twoFactorExpiresAt = Date.now() - 1;
  const payload = {
    username: 'owner',
    password: 'old-password',
    code: authenticator.generate(secret),
  };
  assert.equal((await f.user.twoFactorLogin(payload, req)).code, 450);
  await f.user.login({ username: 'owner', password: 'old-password' }, req);
  assert.equal((await f.user.twoFactorLogin(payload, req)).code, 200);
  await f.user.login({ username: 'owner', password: 'old-password' }, req);
  assert.equal((await f.user.twoFactorLogin(payload, req)).code, 430);
});

test('active two-factor secret cannot be silently replaced and disabling revokes sessions', async () => {
  const f = fixture({
    ...initialized(),
    twoFactorActivated: true,
    twoFactorSecret: authenticator.generateSecret(),
  });
  await assert.rejects(f.user.initTwoFactor());
  await f.user.deactivateTwoFactor();
  assert.equal(f.auth.token, '');
  assert.deepEqual(f.auth.tokens, {});
  assert.equal(f.auth.twoFactorSecret, '');
});

test('default credentials with historical metadata still require initialization', async () => {
  const f = fixture({
    username: 'admin',
    password: 'admin',
    retries: 1,
    token: 'old-default-session',
  });
  assert.equal(
    (await f.user.login({ username: 'admin', password: 'admin' }, req)).code,
    450,
  );
  assert.equal(
    (
      await f.user.initializeUser({
        username: 'owner',
        password: 'new-password',
      })
    ).code,
    200,
  );
  assert.equal(f.auth.token, '');
});
