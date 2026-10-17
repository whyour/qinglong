const assert = require('node:assert/strict');
const test = require('node:test');

const configPath = require.resolve('../../back/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { __esModule: true, default: { logPath: '/ql/data/log' } },
  children: [],
  paths: [],
};

const { commonCronSchema } = require('../../back/validation/schedule');
const { Joi } = require('celebrate');

const schema = Joi.object(commonCronSchema);

test('cron validation accepts leading-zero schedules and legacy null labels', () => {
  const result = schema.validate({
    name: 'legacy cron',
    command: 'task legacy.js',
    schedule: '01 7 * * *',
    labels: null,
  });

  assert.equal(result.error, undefined);
});

test('cron validation identifies invalid fields', () => {
  const result = schema.validate(
    {
      name: 'invalid cron',
      command: 'task invalid.js',
      schedule: '01 7 * * *',
      allow_multiple_instances: '',
    },
    { abortEarly: false },
  );

  assert.deepEqual(
    [...new Set(result.error.details.map((detail) => detail.path.join('.')))],
    ['allow_multiple_instances'],
  );
});

test('extra schedules preserve optional values, compatible syntax and metadata', () => {
  for (const extra_schedules of [
    undefined,
    null,
    [],
    [{ schedule: '0 6/6 * * *', remarks: 'legacy metadata' }],
    [{ schedule: '0 0 * JAN MON#2' }, { schedule: '@hourly' }],
  ]) {
    const result = schema.validate({
      command: 'task valid.js',
      schedule: '01 7 * * *',
      extra_schedules,
    });
    assert.equal(result.error, undefined, JSON.stringify(extra_schedules));
    assert.deepEqual(result.value.extra_schedules, extra_schedules);
  }
  for (const schedule of ['@boot', '@once 1792245000']) {
    assert.equal(
      schema.validate({ command: 'task valid.js', schedule }).error,
      undefined,
    );
  }
});

test('create and update reject invalid extra schedules before calling the service', async (t) => {
  const express = require('express');
  const { errors } = require('celebrate');
  const load = require('../helpers/load-security-module.cjs');
  const mutations = [];
  const service = {
    async create(value) {
      mutations.push(value);
      return { id: 1, ...value };
    },
    async update(value) {
      mutations.push(value);
      return value;
    },
  };
  const route = load('back/api/cron.ts', {
    typedi: {
      Container: {
        get: (key) => (key === 'logger' ? { error() {} } : service),
      },
    },
    '../services/cron': class {},
    '../services/cronView': class {},
    '../validation/schedule': { commonCronSchema },
    '../data/runningInstance': {},
    '../shared/i18n': { t: (value) => value },
    '../schedule/client': { readiness: { async ensureReady() {} } },
  });
  const app = express();
  app.use(express.json());
  route.default(app);
  app.use(errors());
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ message: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const method of ['POST', 'PUT']) {
    const payload = {
      command: 'task valid.js',
      schedule: '01 7 * * *',
      ...(method === 'PUT' ? { id: 1 } : {}),
    };
    const request = (body) =>
      fetch(`http://127.0.0.1:${server.address().port}/crons`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const extra_schedules of [
      [{ schedule: '60 * * * *' }],
      [{ schedule: '0 0 31 2,4 *' }],
      [{ schedule: '' }],
      [{ schedule: 12 }],
      [{ schedule: '@boot' }],
      [{ schedule: '@once 1792245000' }],
      [{}],
      [null],
      ['0 * * * *'],
      [{ schedule: '0 * * * *' }, { schedule: 'invalid' }],
    ]) {
      const before = mutations.length;
      const response = await request({ ...payload, extra_schedules });
      assert.equal(
        response.status,
        400,
        `${method}: ${JSON.stringify(extra_schedules)}`,
      );
      const body = await response.json();
      assert.ok(
        body.validation.body.keys.some((key) =>
          key.startsWith('extra_schedules.'),
        ),
      );
      assert.equal(
        mutations.length,
        before,
        'invalid input must not mutate tasks',
      );
    }
    assert.equal(
      (await request({ ...payload, schedule: '60 * * * *' })).status,
      400,
    );
    const extra_schedules = [{ schedule: '0 6/6 * * *', remarks: 'keep' }];
    const response = await request({ ...payload, extra_schedules });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).data.extra_schedules,
      extra_schedules,
    );
  }
  assert.equal(mutations.length, 2);
});
