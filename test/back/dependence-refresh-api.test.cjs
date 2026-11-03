require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { errors } = require('celebrate');
const { Container } = require('typedi');
const load = require('../helpers/load-security-module.cjs');

test('dependency refresh API starts one job and exposes its status', async (t) => {
  const job = { id: randomUUID(), type: 'nodejs', state: 'running' };
  class DependenceService {
    startRefresh(type) {
      return { job, accepted: type === job.type };
    }
    getRefreshJob(id) {
      return id === job.id ? job : undefined;
    }
    getActiveRefreshJob() {
      return job.state === 'running' ? job : undefined;
    }
  }
  Container.set(DependenceService, new DependenceService());
  t.after(() => Container.remove(DependenceService));

  const api = load('back/api/dependence.ts', {
    '../services/dependence': { __esModule: true, default: DependenceService },
  });
  const app = express();
  app.use(express.json());
  api.default(app);
  app.use(errors());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/dependencies/refresh`;
  const start = (type) =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
    });

  const started = await start('nodejs');
  assert.equal(started.status, 200);
  assert.deepEqual((await started.json()).data, job);
  assert.equal((await start('python3')).status, 409);
  assert.equal((await start('linux')).status, 400);
  const active = await fetch(`${base}/active`);
  assert.equal(active.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await active.json()).data, job);
  const running = await fetch(`${base}/${job.id}`);
  assert.equal(running.headers.get('cache-control'), 'no-store');
  assert.equal((await running.json()).data.state, 'running');
  job.state = 'completed';
  assert.equal((await (await fetch(`${base}/active`)).json()).data, null);
  assert.equal(
    (await (await fetch(`${base}/${job.id}`)).json()).data.state,
    'completed',
  );
  assert.equal((await fetch(`${base}/${randomUUID()}`)).status, 404);
});
