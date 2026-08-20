require('ts-node/register/transpile-only');
require('reflect-metadata');

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const express = require('express');
const { Container } = require('typedi');

const config = require('../../back/config').default;
const UserService = require('../../back/services/user').default;
const registerSystemRoutes = require('../../back/api/system').default;

let authInfo = {
  username: 'operator',
  password: 'changed',
  token: 'redacted',
};
let origin;
let server;

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

before(async () => {
  Container.set('logger', logger);
  Container.set(UserService, {
    async getAuthInfo() {
      return authInfo;
    },
  });
  const app = express();
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  const api = express.Router();
  registerSystemRoutes(api);
  app.use('/api', api);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  Container.remove(UserService);
  Container.remove('logger');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('preserves the public 2.x system readiness envelope', async () => {
  const response = await fetch(`${origin}/api/system`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.code, 200);
  assert.equal(body.data.isInitialized, true);
  assert.equal(body.data.version, '2.21.0');
  assert.equal(body.data.branch, process.env.QL_BRANCH || 'master');
  assert.equal(Number.isSafeInteger(body.data.publishTime), true);
  assert.equal(typeof body.data.changeLog, 'string');
  assert.equal(typeof body.data.changeLogLink, 'string');
  assert.equal(config.apiWhiteList.includes('/api/system'), true);
});

test('keeps default admin credentials distinguishable from readiness', async () => {
  authInfo = { username: 'admin', password: 'admin' };
  const response = await fetch(`${origin}/api/system`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.code, 200);
  assert.equal(body.data.isInitialized, false);
  assert.equal(body.data.version, '2.21.0');
});
