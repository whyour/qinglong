'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  WORKER_SESSION_HEARTBEAT_SCHEMA,
  WORKER_SESSION_REGISTER_SCHEMA,
  WORKER_SESSION_TRANSITION_SCHEMA,
} = require('@qinglong/runtime-core/worker-session-transport');
const {
  WorkerIngressHttpsClient,
  WorkerIngressHttpsClientError,
} = require('../dist/remote-execution/transport/workerIngressHttpsClient');
const {
  WorkerSessionHttpsClient,
} = require('../dist/session/workerSessionHttpsClient');

const authority = {
  workerId: 'edge-1',
  sessionId: '018f5c64-9b9d-7f1a-8c2d-1234567890ac',
};
const capabilitiesJson =
  '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';
const capabilitiesHash = createHash('sha256')
  .update(capabilitiesJson).digest('hex');

function client(exchange) {
  const transport = new WorkerIngressHttpsClient({
    origin: 'https://worker-control.invalid',
    credentials: { async load() { throw new Error('not reached'); } },
  });
  transport.postJson = exchange;
  return new WorkerSessionHttpsClient({ client: transport });
}

test('registers one exact path-bound Session over the shared client', async () => {
  let observed;
  const session = client(async (request) => {
    observed = request;
    return Buffer.from(JSON.stringify({
      schema: WORKER_SESSION_REGISTER_SCHEMA,
      ...authority,
      generation: 1,
      version: 0,
      status: 'online',
      leaseExpiresAtMs: 50_000,
      replacedSession: false,
    }));
  });
  const result = await session.register({
    ...authority,
    capabilitiesJson,
    capabilitiesHash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  assert.equal(result.status, 'online');
  assert.match(observed.path, /\/register$/);
  assert.equal(observed.body.schema, WORKER_SESSION_REGISTER_SCHEMA);
  assert.equal('workerId' in observed.body, false);
  assert.equal(observed.maximumRequestBytes, 20 * 1024);
});

test('heartbeats and transitions under exact next-version fences', async () => {
  const operations = [];
  const session = client(async (request) => {
    operations.push(request.body.schema);
    const transition = request.body.schema === WORKER_SESSION_TRANSITION_SCHEMA;
    return Buffer.from(JSON.stringify({
      schema: request.body.schema,
      ...authority,
      generation: 2,
      version: request.body.expectedVersion + 1,
      status: transition ? request.body.status : 'online',
      leaseExpiresAtMs: 60_000,
    }));
  });
  const heartbeat = await session.heartbeat({
    ...authority, generation: 2, expectedVersion: 3,
    availableSlots: 1, leaseDurationMs: 30_000,
  });
  assert.equal(heartbeat.version, 4);
  const drained = await session.transition({
    ...authority, generation: 2, expectedVersion: 4, status: 'draining',
  });
  assert.equal(drained.status, 'draining');
  assert.deepEqual(operations, [
    WORKER_SESSION_HEARTBEAT_SCHEMA,
    WORKER_SESSION_TRANSITION_SCHEMA,
  ]);
});

test('rejects response authority and version drift', async () => {
  const session = client(async () => Buffer.from(JSON.stringify({
    schema: WORKER_SESSION_HEARTBEAT_SCHEMA,
    ...authority,
    generation: 2,
    version: 99,
    status: 'online',
    leaseExpiresAtMs: 60_000,
  })));
  await assert.rejects(
    session.heartbeat({
      ...authority, generation: 2, expectedVersion: 3,
      availableSlots: 1, leaseDurationMs: 30_000,
    }),
    /response_invalid/,
  );
});

test('classifies credential rejection and Session fencing without error bodies', async () => {
  for (const [statusCode, reason] of [
    [401, 'credential_rejected'],
    [403, 'credential_rejected'],
    [409, 'session_fenced'],
    [503, 'transport_unavailable'],
  ]) {
    const session = client(async () => {
      throw new WorkerIngressHttpsClientError(
        'response_rejected',
        statusCode,
      );
    });
    await assert.rejects(
      session.heartbeat({
        ...authority, generation: 2, expectedVersion: 3,
        availableSlots: 1, leaseDurationMs: 30_000,
      }),
      (error) => error.reason === reason,
    );
  }
});
