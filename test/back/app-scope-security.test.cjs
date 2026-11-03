const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { errors } = require('celebrate');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');

test('application API rejects granting apps scope on create and update', async (t) => {
  const calls = [];
  class OpenService {}
  const service = {
    create: async (body) => {
      calls.push(['create', body]);
      return body;
    },
    update: async (body) => {
      calls.push(['update', body]);
      return body;
    },
  };
  const route = load(path.join(__dirname, '../../back/api/open.ts'), {
    '../services/open': OpenService,
    typedi: { Container: { get: () => service } },
  }).default;
  const app = express();
  app.use(express.json());
  for (const prefix of ['/api', '/open']) {
    const router = express.Router();
    route(router);
    app.use(prefix, router);
  }
  app.use(errors());
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const request = async (prefix, method, body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${prefix}/apps`,
      {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return response.status;
  };
  for (const prefix of ['/api', '/open']) {
    assert.equal(
      await request(prefix, 'POST', { name: 'new', scopes: ['crons', 'apps'] }),
      400,
    );
    assert.equal(
      await request(prefix, 'PUT', { id: 1, scopes: ['apps'] }),
      400,
    );
    assert.equal(
      await request(prefix, 'POST', { name: 'new', scopes: ['crons:read'] }),
      200,
    );
    assert.equal(
      await request(prefix, 'PUT', { id: 1, scopes: ['crons'] }),
      200,
    );
  }
  assert.equal(calls.length, 4);
});
