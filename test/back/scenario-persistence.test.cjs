const test = require('node:test'),
  assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const express = require('express');
const { errors } = require('celebrate');
const load = require('../helpers/load-security-module.cjs');
test('scenario API preserves native workflow data and validates pagination, IDs and status', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const cache = new Map();
  const mocks = {
    '.': { sequelize: database },
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
  };
  const model = load('back/data/scenario.ts', mocks, cache).ScenarioModel;
  await model.sync();
  t.after(() => database.close());
  const Service = load('back/services/scenario.ts', mocks, cache).default;
  const service = new Service({});
  mocks.typedi.Container = { get: () => service };
  const app = express();
  app.use(express.json());
  load('back/api/scenario.ts', mocks, cache).default(app);
  app.use(errors());
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ code: e.status || 500 }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  async function request(method, url, body) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/scenarios${url}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  }
  const graph = {
    nodes: [
      { id: 'start', type: 'start', data: { title: 'Start' } },
      {
        id: 'loop',
        type: 'loop',
        blocks: [
          {
            id: 'inside',
            type: 'http',
            data: { url: 'https://example.invalid' },
          },
        ],
        meta: { expanded: true },
      },
    ],
    edges: [{ source: 'start', target: 'loop' }],
    viewport: { x: 7, y: 8, zoom: 0.5 },
  };
  const created = await request('POST', '', {
    name: 'workflow',
    workflowGraph: graph,
    status: 1,
  });
  assert.equal(created.status, 200);
  const id = created.body.data.id;
  assert.deepEqual(created.body.data.workflowGraph, graph);
  await request('PUT', '', { id, name: 'renamed' });
  const reopened = await request('GET', `/${id}`);
  assert.deepEqual(reopened.body.data.workflowGraph, graph);
  assert.equal(reopened.body.data.status, 1);
  assert.equal((await request('GET', '?page=0')).status, 400);
  assert.equal((await request('GET', '?size=201')).status, 400);
  assert.equal(
    (await request('POST', '', { name: 'bad', status: 2 })).status,
    400,
  );
  assert.equal((await request('GET', '/999')).status, 404);
  assert.equal((await request('DELETE', '', [-1])).status, 400);
  const listed = await request('GET', '?page=1&size=1');
  assert.equal(listed.body.data.total, 1);
  await request('DELETE', '', [id]);
  assert.equal((await request('GET', `/${id}`)).status, 404);
});
