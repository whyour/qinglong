const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { DatabaseClient } = require('../../back/data/databaseClient');
const { Repository } = require('../../back/data/repository');
const { initialize } = require('../helpers/repository-fixture.cjs');

function mockModule(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

test('instance API retains newest-first ordering independently of insertion order', async (t) => {
  const db = new DatabaseClient(':memory:');
  t.after(() => db.close());
  await initialize(db);
  const instances = new Repository('RunningInstance', () => db);
  for (const [cron_id, started_at] of [
    [7, 200],
    [7, 300],
    [8, 900],
    [7, 100],
  ]) {
    await instances.insert({ cron_id, started_at, status: 2 });
  }
  for (const service of ['cron', 'cronView']) {
    mockModule(`../../back/services/${service}`, {
      __esModule: true,
      default: class {},
    });
  }
  mockModule('../../back/schedule/client', { __esModule: true, default: {} });
  mockModule('../../back/shared/i18n', { t: (message) => message });
  mockModule('../../back/data/runningInstance', {
    RunningInstanceModel: instances,
    InstanceStatus: { running: 0 },
  });
  const app = express.Router();
  require('../../back/api/cron').default(app);
  const router = app.stack.find((layer) => layer.name === 'router').handle;
  const handler = router.stack
    .find((layer) => layer.route?.path === '/:id/instances')
    .route.stack.at(-1).handle;
  let response;
  await handler(
    { params: { id: 7 } },
    {
      send: (body) => {
        response = body;
      },
    },
    (error) => {
      throw error;
    },
  );
  assert.equal(response.code, 200);
  assert.deepEqual(
    response.data.map((row) => row.started_at),
    [300, 200, 100],
  );
  assert(response.data.every((row) => row.cron_id === 7));
});
