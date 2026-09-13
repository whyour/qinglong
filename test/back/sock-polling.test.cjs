const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const jwt = require('jsonwebtoken');
const { isValidToken } = require('../../back/shared/auth');

async function setup() {
  const secret = 'polling-test';
  const token = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: '1h' });
  let auth = { token };
  let read = async () => auth;
  let reads = 0;
  let onConnection;
  const clients = new Set();
  const timers = new Set();
  const mocks = {
    sockjs: {
      createServer: () => ({
        on: (_, fn) => {
          onConnection = fn;
        },
        installHandlers() {},
      }),
    },
    typedi: {
      Container: {
        get: () => ({
          addClient: (c) => clients.add(c),
          removeClient: (c) => clients.delete(c),
        }),
      },
    },
    '../services/sock': class {},
    '../config/util': { getPlatform: () => 'desktop' },
    '../shared/store': {
      shareStore: {
        getAuthInfo: () => {
          reads++;
          return read();
        },
      },
    },
    '../shared/auth': { isValidToken },
    '../config': { baseUrl: '', jwt: { secret } },
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../../back/loaders/sock.ts'),
    'utf8',
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'setInterval',
    'clearInterval',
    outputText,
  )(
    (name) => {
      assert.ok(Object.hasOwn(mocks, name), name);
      return mocks[name];
    },
    module,
    module.exports,
    (callback, delay) => {
      assert.equal(delay, 1000);
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    (timer) => timers.delete(timer),
  );
  await module.exports.default({ server: {} });
  function connection(value = token) {
    const conn = new EventEmitter();
    Object.assign(conn, {
      headers: {},
      pathname: '/api/ws/a/b/websocket',
      url: `/api/ws/a/b/websocket?token=${value}`,
      write() {},
      close(code) {
        this.closeCode = code;
        this.emit('close');
      },
    });
    return conn;
  }
  return {
    token,
    secret,
    clients,
    timers,
    connection,
    connect: (c) => onConnection(c),
    get reads() {
      return reads;
    },
    setAuth(value) {
      auth = value;
    },
    setRead(fn) {
      read = fn;
    },
    tick: () => Promise.all([...timers].map((t) => t.callback())),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

test('multiple sockets share one periodic read, revoke together, and stop polling when empty', async () => {
  const h = await setup();
  assert.equal(h.timers.size, 0);
  const sockets = Array.from({ length: 20 }, () => h.connection());
  await Promise.all(sockets.map(h.connect));
  assert.equal(h.reads, 20, 'initial authentication remains per connection');
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal(h.reads, 21);
  assert.equal(h.clients.size, 20);
  h.setAuth({ token: '' });
  await h.tick();
  assert.ok(sockets.every((c) => c.closeCode === '401'));
  assert.equal(h.clients.size, 0);
  assert.equal(h.timers.size, 0);
  const c = h.connection();
  h.setAuth({ token: h.token });
  await h.connect(c);
  assert.equal(h.timers.size, 1);
  c.close();
  assert.equal(h.timers.size, 0);
});

test('slow reads do not overlap and old snapshots do not reject newly accepted sockets', async () => {
  const h = await setup();
  const old = h.connection();
  await h.connect(old);
  const pending = deferred();
  h.setRead(() => pending.promise);
  const tick = h.tick();
  await h.tick();
  assert.equal(h.reads, 2);
  old.close();
  h.setRead(async () => ({ token: h.token }));
  const fresh = h.connection();
  await h.connect(fresh);
  pending.resolve({ token: '' });
  await tick;
  assert.equal(h.clients.has(fresh), true);
  assert.equal(fresh.closeCode, undefined);
  await h.tick();
  assert.equal(h.reads, 4);
  fresh.close();
});

test('periodic store failures disconnect the checked sessions', async () => {
  const h = await setup();
  const c = h.connection();
  await h.connect(c);
  h.setRead(async () => {
    throw new Error('database unavailable');
  });
  await h.tick();
  assert.equal(c.closeCode, '401');
  assert.equal(h.clients.size, 0);
  assert.equal(h.timers.size, 0);
});

test('closed connections cannot be added after initial authentication finishes', async () => {
  const h = await setup();
  const pending = deferred();
  h.setRead(() => pending.promise);
  const c = h.connection();
  const connecting = h.connect(c);
  c.close();
  pending.resolve({ token: h.token });
  await connecting;
  assert.equal(h.clients.size, 0);
  assert.equal(h.timers.size, 0);
});

test('initial store errors reject the connection without creating a timer', async () => {
  const h = await setup();
  h.setRead(async () => {
    throw new Error('database unavailable');
  });
  const c = h.connection();
  await h.connect(c);
  assert.equal(c.closeCode, '401');
  assert.equal(h.clients.size, 0);
  assert.equal(h.timers.size, 0);
});

test('each periodic check still validates JWT expiry and platform session membership', async () => {
  const h = await setup();
  const expired = h.connection(
    jwt.sign({}, h.secret, { algorithm: 'HS384', expiresIn: -1 }),
  );
  await h.connect(expired);
  assert.equal(expired.closeCode, '404');
  const c = h.connection();
  await h.connect(c);
  h.setAuth({ tokens: { desktop: [{ value: h.token, expiration: 1 }] } });
  await h.tick();
  assert.equal(c.closeCode, '401');
  assert.equal(h.timers.size, 0);
});

test('an accepted JWT is disconnected when it expires without a store change', async () => {
  const h = await setup();
  const c = h.connection();
  await h.connect(c);
  const now = Date.now;
  try {
    Date.now = () => now() + 2 * 60 * 60 * 1000;
    await h.tick();
  } finally {
    Date.now = now;
  }
  assert.equal(c.closeCode, '401');
  assert.equal(h.timers.size, 0);
});
