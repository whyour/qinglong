const test = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('@grpc/grpc-js');
const load = require('../helpers/load-security-module.cjs');

for (const method of ['addCron', 'delCron']) {
  test(`${method} invalidates an uncertain timed-out write without replaying it`, async () => {
    let writes = 0;
    let invalidations = 0;
    const timeout = Object.assign(new Error('response deadline exceeded'), {
      code: grpc.status.DEADLINE_EXCEEDED,
    });
    const fake = {
      waitForReady: (_deadline, callback) => callback(),
      [method]: (_request, _metadata, _options, callback) => {
        // The server may have applied the write before the response was lost.
        writes++;
        callback(timeout);
      },
    };
    const client = load('back/schedule/client.ts', {
      '../protos/cron': {
        ...require('../../back/protos/cron'),
        CronClient: class {
          constructor() {
            return fake;
          }
        },
      },
      '../config': { grpcPort: 5500 },
      '../config/grpcCerts': {
        getGrpcCerts: () => ({
          caCert: 'ca',
          clientKey: 'key',
          clientCert: 'cert',
        }),
      },
      '@grpc/grpc-js': { ...grpc, credentials: { createSsl: () => ({}) } },
    }).default;
    client.readiness.invalidate = () => invalidations++;
    await assert.rejects(client[method]([]), (error) => error === timeout);
    assert.equal(
      invalidations,
      1,
      'reconcile from the DB after an uncertain RPC result',
    );
    assert.equal(timeout.status, 503);
    assert.equal(writes, 1, 'do not replay an uncertain mutation');
  });
}

test('registration serializes nullable SQLite scheduling fields as absent', async () => {
  const { AddCronRequest, ICron } = require('../../back/protos/cron');
  const client = load('back/schedule/client.ts', {}).default;
  let received;
  client._client = {
    waitForReady: (_deadline, callback) => callback(),
    addCron(request, _metadata, _options, callback) {
      received = AddCronRequest.decode(AddCronRequest.encode(request).finish());
      callback(null, {});
    },
  };
  const legacy = {
    id: '1', extra_schedules: null, max_queue_wait: null, catchup_seconds: null, recovery_from: null,
  };
  const configured = {
    id: '2', schedule: '* * * * *', extra_schedules: [{ schedule: '0 1 * * *' }],
    max_queue_wait: 0, catchup_seconds: 60, recovery_from: 1700000000000,
  };
  await client.addCron([legacy, configured], true);
  assert.equal(received.replace, true);
  assert.deepEqual(received.crons, [ICron.create({ id: '1' }), ICron.create(configured)]);
});
