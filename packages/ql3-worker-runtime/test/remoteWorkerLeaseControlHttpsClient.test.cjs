'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  WorkerIngressHttpsClient,
  WorkerRemoteLeaseControlHttpsClient,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const AUTHORIZATION =
  `Worker ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}`;

function command(overrides = {}) {
  return {
    workerId: 'edge-1', workerSessionId: SESSION_ID, workerGeneration: 2,
    projectId: 'project-1', runId: 'run-1', attemptId: 'attempt-1',
    offerId: 'offer-1', leaseGeneration: 3, leaseToken: LEASE_TOKEN,
    expectedLeaseVersion: 4, ...overrides,
  };
}

function responseBody(overrides = {}) {
  return {
    schema: 'qinglong/remote-worker-lease-control@v1',
    status: 'renewed', projectId: 'project-1', runId: 'run-1',
    attemptId: 'attempt-1', offerId: 'offer-1', leaseGeneration: 3,
    leaseVersion: 5, renewedAtMs: 10_000, expiresAtMs: 40_000,
    stop: null, terminalStatus: null, ...overrides,
  };
}

function response(value) {
  const serialized = JSON.stringify(value);
  const stream = new PassThrough();
  stream.statusCode = 200;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(serialized)),
  };
  queueMicrotask(() => stream.end(serialized));
  return stream;
}

function fixture(responseFactory = () => responseBody()) {
  const observations = [];
  const shared = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example:7443',
    credentials: { async load() {
      return {
        authorization: AUTHORIZATION,
        certificateChainPem: 'client certificate',
        privateKeyPem: 'client private key',
        trustAnchors: ['trusted ca'],
      };
    } },
    requestFactory(options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => {
        if (error) queueMicrotask(() => request.emit('error', error));
      };
      request.end = (body) => {
        observations.push({
          path: options.path,
          body: JSON.parse(Buffer.from(body).toString('utf8')),
        });
        queueMicrotask(() => callback(response(responseFactory())));
      };
      return request;
    },
  });
  return {
    observations,
    shared,
    client: new WorkerRemoteLeaseControlHttpsClient({ client: shared }),
  };
}

test('posts a path-bound fence and accepts only the next lease version', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.client.control(command()), {
      status: 'renewed', projectId: 'project-1', runId: 'run-1',
      attemptId: 'attempt-1', offerId: 'offer-1', leaseGeneration: 3,
      leaseVersion: 5, renewedAtMs: 10_000, expiresAtMs: 40_000,
    });
    assert.equal(f.observations[0].path,
      `/api/v3/worker-ingress/workers/edge-1/sessions/${SESSION_ID}/lease-control`);
    assert.equal('workerId' in f.observations[0].body, false);
    assert.equal('workerSessionId' in f.observations[0].body, false);
    assert.equal(f.observations[0].body.leaseToken, LEASE_TOKEN);
  } finally { f.shared.close(); }
});

test('accepts a durable stop request after the lease is renewed', async () => {
  const f = fixture(() => responseBody({
    status: 'stop_requested',
    stop: { reason: 'user', requestedAtMs: 9_000 },
  }));
  try {
    const result = await f.client.control(command());
    assert.equal(result.status, 'stop_requested');
    assert.deepEqual(result.stop, { reason: 'user', requestedAtMs: 9_000 });
  } finally { f.shared.close(); }
});

test('rejects response identity or lease-version drift', async () => {
  for (const drift of [
    { runId: 'run-other' },
    { leaseVersion: 6 },
  ]) {
    const f = fixture(() => responseBody(drift));
    try {
      await assert.rejects(f.client.control(command()), /response_invalid/);
    } finally { f.shared.close(); }
  }
});

test('rejects invalid requests before any transport access', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.client.control(command({ leaseToken: 'short' })),
      /request_invalid/,
    );
    assert.equal(f.observations.length, 0);
  } finally { f.shared.close(); }
});
