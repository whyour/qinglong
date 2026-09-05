const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const load = require('../helpers/load-security-module.cjs');

test('WebSocket connections reject expired tokens and close when sessions are revoked', async () => {
  const secret = 'sock-test';
  const valid = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: '1h' });
  const expired = jwt.sign({}, secret, { algorithm: 'HS384', expiresIn: -1 });
  let auth = { token: valid, tokens: { desktop: [{ value: expired }] } };
  let onConnection;
  const clients = new Set();
  const Sock = class {};
  const loader = load(path.join(__dirname, '../../back/loaders/sock.ts'), {
    sockjs: {
      createServer: () => ({
        on: (_event, fn) => {
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
    '../services/sock': Sock,
    '../config': { jwt: { secret }, baseUrl: '' },
    '../config/util': { getPlatform: () => 'desktop' },
    '../shared/store': { shareStore: { getAuthInfo: async () => auth } },
  }).default;
  await loader({ server: {} });
  const connection = (token) => {
    const c = new EventEmitter();
    Object.assign(c, {
      headers: {},
      pathname: '/api/ws/a/b/websocket',
      url: `/api/ws/a/b/websocket?token=${token}`,
      close() {
        this.closed = true;
        this.emit('close');
      },
      write() {},
    });
    return c;
  };
  const rejected = connection(expired);
  await onConnection(rejected);
  assert.equal(rejected.closed, true);
  assert.equal(clients.size, 0);
  const accepted = connection(valid);
  await onConnection(accepted);
  assert.equal(clients.size, 1);
  auth = { token: '', tokens: {} };
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      accepted.close();
      reject(new Error('revoked socket remained open'));
    }, 3000);
    accepted.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.equal(clients.size, 0);
});
