'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerIngressHttpsClient,
  WorkerIngressHttpsClientError,
} = require('../dist/remote-execution/transport/workerIngressHttpsClient');
const {
  WorkerSessionHttpsClient,
} = require('../dist/session/workerSessionHttpsClient');
const {
  WorkerSessionCoordinator,
} = require('../dist/session/workerSessionCoordinator');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';

function capabilities() {
  return {
    architecture: 'amd64',
    operatingSystem: 'linux',
    executors: ['remote-worker'],
    protocolVersion: '1.0.0',
    supportTier: 'tier1',
    runtimes: [{ name: 'node', version: '24.14.0' }],
    labels: {},
    capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
    features: [],
  };
}

function fixture() {
  let now = 1_000;
  let version = -1;
  let status = 'online';
  let rejectionStatus;
  const calls = [];
  const transport = new WorkerIngressHttpsClient({
    origin: 'https://worker-control.invalid',
    credentials: { async load() { throw new Error('not reached'); } },
  });
  transport.postJson = async (request) => {
    calls.push(request.body);
    if (rejectionStatus !== undefined) {
      throw new WorkerIngressHttpsClientError(
        'response_rejected',
        rejectionStatus,
      );
    }
    if (request.body.schema.endsWith('register@v1')) {
      version = 0;
      status = 'online';
      return Buffer.from(JSON.stringify({
        schema: request.body.schema,
        workerId: 'edge-1', sessionId: SESSION_ID,
        generation: 1, version, status,
        leaseExpiresAtMs: now + 45_000,
        replacedSession: false,
      }));
    }
    version += 1;
    if (request.body.schema.endsWith('transition@v1')) {
      status = request.body.status;
    }
    return Buffer.from(JSON.stringify({
      schema: request.body.schema,
      workerId: 'edge-1', sessionId: SESSION_ID,
      generation: 1, version, status,
      leaseExpiresAtMs: now + 45_000,
    }));
  };
  const coordinator = new WorkerSessionCoordinator({
    client: new WorkerSessionHttpsClient({ client: transport }),
    workerId: 'edge-1',
    capabilities: capabilities(),
    maxConcurrentRuns: 2,
    availableSlots: () => 1,
    leaseDurationMs: 45_000,
    heartbeatIntervalMs: 10_000,
    now: () => now,
    createSessionId: () => SESSION_ID,
  });
  return {
    coordinator,
    calls,
    advance(value) { now += value; },
    setNow(value) { now = value; },
    rejectWith(value) { rejectionStatus = value; },
  };
}

test('registers canonical capabilities and exposes one live execution Session', async () => {
  const context = fixture();
  const registered = await context.coordinator.register();
  assert.equal(registered.status, 'available');
  assert.equal(context.coordinator.current().sessionId, SESSION_ID);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].availableSlots, 1);
  assert.equal(
    require('node:crypto').createHash('sha256')
      .update(context.calls[0].capabilitiesJson).digest('hex'),
    context.calls[0].capabilitiesHash,
  );
});

test('uses caller-driven due heartbeats without creating a timer', async () => {
  const context = fixture();
  await context.coordinator.register();
  assert.equal((await context.coordinator.tick()).status, 'not_due');
  context.advance(10_000);
  const result = await context.coordinator.tick();
  assert.equal(result.status, 'heartbeat');
  assert.equal(result.session.version, 1);
  assert.equal(context.calls.length, 2);
});

test('drains with zero capacity, heartbeats, then disconnects in order', async () => {
  const context = fixture();
  await context.coordinator.register();
  await context.coordinator.beginDrain();
  assert.equal(context.coordinator.current().status, 'draining');
  context.advance(10_000);
  await context.coordinator.tick();
  assert.equal(context.calls.at(-1).availableSlots, 0);
  await context.coordinator.disconnect();
  assert.equal(context.coordinator.currentRecord().status, 'offline');
  assert.equal(context.coordinator.current().status, 'offline');
  const completedCalls = context.calls.length;
  await context.coordinator.beginDrain();
  await context.coordinator.disconnect();
  assert.equal(context.calls.length, completedCalls);
});

test('fails closed locally after the observed Session lease expires', async () => {
  const context = fixture();
  await context.coordinator.register();
  context.advance(45_000);
  assert.equal(context.coordinator.current(), undefined);
  assert.equal((await context.coordinator.tick()).status, 'lease_expired');
  await assert.rejects(context.coordinator.beginDrain(), /lease_expired/);
});

test('pauses Pull on credential/fence rejection and recovers the same Session', async () => {
  const context = fixture();
  await context.coordinator.register();
  context.advance(10_000);
  context.rejectWith(401);
  await assert.rejects(
    context.coordinator.tick(),
    (error) => error.reason === 'credential_rejected',
  );
  assert.equal(context.coordinator.current(), undefined);

  context.rejectWith(undefined);
  const recovered = await context.coordinator.tick();
  assert.equal(recovered.status, 'heartbeat');
  assert.equal(context.coordinator.current().sessionId, SESSION_ID);

  context.advance(10_000);
  context.rejectWith(409);
  await assert.rejects(
    context.coordinator.tick(),
    (error) => error.reason === 'session_fenced',
  );
  assert.equal(context.coordinator.current(), undefined);
});

test('keeps certificate fail-closed until an authenticated heartbeat succeeds', async () => {
  const context = fixture();
  await context.coordinator.register();
  context.coordinator.failClosed();
  assert.equal(context.coordinator.current(), undefined);
  assert.equal((await context.coordinator.tick()).status, 'not_due');
  assert.equal(context.coordinator.current(), undefined);
  context.advance(10_000);
  assert.equal((await context.coordinator.tick()).status, 'heartbeat');
  assert.equal(context.coordinator.current().sessionId, SESSION_ID);
});

test('keeps a live Session available across transient server failure', async () => {
  const context = fixture();
  await context.coordinator.register();
  context.advance(10_000);
  context.rejectWith(503);
  await assert.rejects(
    context.coordinator.tick(),
    (error) => error.reason === 'transport_unavailable',
  );
  assert.equal(context.coordinator.current().sessionId, SESSION_ID);
});
