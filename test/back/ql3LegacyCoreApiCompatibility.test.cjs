require('ts-node/register/transpile-only');
require('reflect-metadata');

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const express = require('express');
const { errors } = require('celebrate');
const { Container } = require('typedi');

const CronService = require('../../back/services/cron').default;
const SubscriptionService = require('../../back/services/subscription').default;
const registerCronRoutes = require('../../back/api/cron').default;
const registerSubscriptionRoutes =
  require('../../back/api/subscription').default;

const calls = [];
let origin;
let server;
let serverListening = false;

function record(domain, operation, args, result) {
  calls.push({ domain, operation, args });
  return Promise.resolve(result);
}

const cronService = {
  crontabs: (...args) =>
    record('cron', 'list', args, {
      data: [{ id: 11, name: 'legacy-task', status: 0 }],
      total: 1,
    }),
  create: (...args) =>
    record('cron', 'create', args, {
      id: 11,
      ...args[0],
      status: 0,
    }),
  update: (...args) =>
    record('cron', 'update', args, {
      ...args[0],
      status: 0,
    }),
  disabled: (...args) => record('cron', 'disable', args, undefined),
  enabled: (...args) => record('cron', 'enable', args, undefined),
  run: (...args) => record('cron', 'run', args, undefined),
  stop: (...args) => record('cron', 'stop', args, undefined),
  log: (...args) =>
    record('cron', 'log', args, {
      content: 'legacy log\n',
      status: 'running',
    }),
  logs: (...args) => record('cron', 'logs', args, ['one.log', 'two.log']),
  stopInstance: (...args) =>
    record('cron', 'stop-instance', args, {
      code: 200,
      message: '实例已停止',
    }),
};

const subscriptionService = {
  list: (...args) =>
    record('subscription', 'list', args, [
      { id: 21, name: 'legacy-subscription', status: 0 },
    ]),
  create: (...args) =>
    record('subscription', 'create', args, {
      id: 21,
      ...args[0],
      status: 0,
    }),
  update: (...args) =>
    record('subscription', 'update', args, {
      ...args[0],
      status: 0,
    }),
  disabled: (...args) => record('subscription', 'disable', args, undefined),
  enabled: (...args) => record('subscription', 'enable', args, undefined),
  run: (...args) => record('subscription', 'run', args, undefined),
  stop: (...args) => record('subscription', 'stop', args, undefined),
  log: (...args) => record('subscription', 'log', args, 'subscription log\n'),
};

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

async function request(method, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? undefined : JSON.parse(text),
  };
}

function lastCall() {
  return calls.at(-1);
}

before(async () => {
  Container.set('logger', logger);
  Container.set(CronService, cronService);
  Container.set(SubscriptionService, subscriptionService);

  const app = express();
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.use(express.json());

  const api = express.Router();
  registerCronRoutes(api);
  registerSubscriptionRoutes(api);
  app.use('/api', api);
  app.use(errors());
  app.use((error, _request, response, _next) => {
    response.status(error.status || 500).json({
      code: error.status || 500,
      message: error.message,
    });
  });

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  serverListening = true;
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  Container.remove(CronService);
  Container.remove(SubscriptionService);
  Container.remove('logger');
  if (serverListening) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('preserves the 2.x Cron API envelope across the QingLong 3.0 runtime boundary', async (t) => {
  await t.test(
    'lists tasks with the existing query and response shape',
    async () => {
      const response = await request(
        'GET',
        '/api/crons?searchValue=legacy&page=1&size=20',
      );
      assert.deepEqual(response, {
        status: 200,
        body: {
          code: 200,
          data: {
            data: [{ id: 11, name: 'legacy-task', status: 0 }],
            total: 1,
          },
        },
      });
      assert.deepEqual(lastCall(), {
        domain: 'cron',
        operation: 'list',
        args: [
          {
            searchValue: 'legacy',
            page: '1',
            size: '20',
          },
        ],
      });
    },
  );

  const createBody = {
    name: 'legacy-task',
    command: 'echo compatible',
    schedule: '0 0 * * *',
  };

  await t.test(
    'creates and updates tasks without adding a v3-only envelope',
    async () => {
      const created = await request('POST', '/api/crons', createBody);
      assert.equal(created.status, 200);
      assert.deepEqual(created.body, {
        code: 200,
        data: { id: 11, ...createBody, status: 0 },
      });
      assert.deepEqual(lastCall(), {
        domain: 'cron',
        operation: 'create',
        args: [createBody],
      });

      const updateBody = { id: 11, ...createBody, command: 'echo updated' };
      const updated = await request('PUT', '/api/crons', updateBody);
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.body, {
        code: 200,
        data: { ...updateBody, status: 0 },
      });
      assert.deepEqual(lastCall(), {
        domain: 'cron',
        operation: 'update',
        args: [updateBody],
      });
    },
  );

  for (const operation of ['disable', 'enable', 'run', 'stop']) {
    await t.test(
      `${operation} keeps the code-only success response`,
      async () => {
        const response = await request('PUT', `/api/crons/${operation}`, [11]);
        assert.deepEqual(response, { status: 200, body: { code: 200 } });
        assert.deepEqual(lastCall(), {
          domain: 'cron',
          operation,
          args: [[11]],
        });
      },
    );
  }

  await t.test(
    'keeps task log and instance-stop response contracts',
    async () => {
      const log = await request('GET', '/api/crons/11/log');
      assert.deepEqual(log, {
        status: 200,
        body: {
          code: 200,
          data: 'legacy log\n',
          logStatus: 'running',
        },
      });
      assert.deepEqual(lastCall(), {
        domain: 'cron',
        operation: 'log',
        args: [11],
      });

      const logs = await request('GET', '/api/crons/11/logs');
      assert.deepEqual(logs, {
        status: 200,
        body: { code: 200, data: ['one.log', 'two.log'] },
      });
      assert.deepEqual(lastCall(), {
        domain: 'cron',
        operation: 'logs',
        args: [11],
      });

      const stopped = await request('POST', '/api/crons/11/instances/101/stop');
      assert.deepEqual(stopped, {
        status: 200,
        body: { code: 200, message: '实例已停止' },
      });
      assert.deepEqual(lastCall(), {
        domain: 'cron',
        operation: 'stop-instance',
        args: [101],
      });
    },
  );

  await t.test(
    'rejects an invalid execution request before service dispatch',
    async () => {
      const callCount = calls.length;
      const response = await request('PUT', '/api/crons/run', ['x']);
      assert.equal(response.status, 400);
      assert.equal(calls.length, callCount);
    },
  );
});

test('preserves the 2.x Subscription API envelope across the QingLong 3.0 runtime boundary', async (t) => {
  await t.test('lists subscriptions with both legacy filters', async () => {
    const response = await request(
      'GET',
      '/api/subscriptions?searchValue=legacy&ids=%5B21%5D',
    );
    assert.deepEqual(response, {
      status: 200,
      body: {
        code: 200,
        data: [{ id: 21, name: 'legacy-subscription', status: 0 }],
      },
    });
    assert.deepEqual(lastCall(), {
      domain: 'subscription',
      operation: 'list',
      args: ['legacy', '[21]'],
    });
  });

  const createBody = {
    type: 'public-repo',
    url: 'https://example.invalid/repository.git',
    schedule_type: 'cron',
    alias: 'legacy-subscription',
  };

  await t.test(
    'creates and updates subscriptions with the legacy envelope',
    async () => {
      const created = await request('POST', '/api/subscriptions', createBody);
      assert.deepEqual(created, {
        status: 200,
        body: {
          code: 200,
          data: { id: 21, ...createBody, status: 0 },
        },
      });
      assert.deepEqual(lastCall(), {
        domain: 'subscription',
        operation: 'create',
        args: [createBody],
      });

      const updateBody = {
        id: 21,
        type: 'public-repo',
        url: 'https://example.invalid/updated.git',
        alias: 'legacy-subscription',
      };
      const updated = await request('PUT', '/api/subscriptions', updateBody);
      assert.deepEqual(updated, {
        status: 200,
        body: {
          code: 200,
          data: { ...updateBody, status: 0 },
        },
      });
      assert.deepEqual(lastCall(), {
        domain: 'subscription',
        operation: 'update',
        args: [updateBody],
      });
    },
  );

  for (const operation of ['disable', 'enable', 'run', 'stop']) {
    await t.test(
      `${operation} keeps the code-only success response`,
      async () => {
        const response = await request(
          'PUT',
          `/api/subscriptions/${operation}`,
          [21],
        );
        assert.deepEqual(response, { status: 200, body: { code: 200 } });
        assert.deepEqual(lastCall(), {
          domain: 'subscription',
          operation,
          args: [[21]],
        });
      },
    );
  }

  await t.test('keeps the subscription log response contract', async () => {
    const response = await request('GET', '/api/subscriptions/21/log');
    assert.deepEqual(response, {
      status: 200,
      body: { code: 200, data: 'subscription log\n' },
    });
    assert.deepEqual(lastCall(), {
      domain: 'subscription',
      operation: 'log',
      args: [21],
    });
  });

  await t.test(
    'rejects an invalid stop request before service dispatch',
    async () => {
      const callCount = calls.length;
      const response = await request('PUT', '/api/subscriptions/stop', [
        21,
        'x',
      ]);
      assert.equal(response.status, 400);
      assert.equal(calls.length, callCount);
    },
  );
});
