'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  WorkerRemoteOfferHttpsTransport,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const AUTHORIZATION =
  `Worker ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}`;
const PATH =
  '/api/v3/worker-ingress/workers/edge-1/sessions/018f0000-0000-7000-8000-000000000001/offers';

function requestFactory(responseFactory, observations) {
  return (options, callback) => {
    observations.options = options;
    const request = new EventEmitter();
    request.setTimeout = (timeout, handler) => {
      observations.timeout = timeout;
      observations.timeoutHandler = handler;
      return request;
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = (body) => {
      observations.body = Buffer.from(body);
      const response = responseFactory();
      queueMicrotask(() => callback(response));
    };
    return request;
  };
}

function response(body, headers = {}) {
  const stream = new PassThrough();
  stream.statusCode = 200;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  };
  queueMicrotask(() => stream.end(body));
  return stream;
}

function credentials() {
  return {
    authorization: AUTHORIZATION,
    certificateChainPem: 'client certificate',
    privateKeyPem: 'client private key',
    trustAnchors: ['trusted ca'],
  };
}

function request() {
  return {
    path: PATH,
    body: {
      workerGeneration: 2,
      offerId: 'offer-1',
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
    },
    maximumResponseBytes: 1024,
  };
}

test('uses one bounded TLS 1.3 mTLS POST with the Worker credential', async () => {
  const observations = {};
  const transport = new WorkerRemoteOfferHttpsTransport({
    origin: 'https://cluster.example:7443',
    credentials: { async load() { return credentials(); } },
    requestTimeoutMs: 5_000,
    requestFactory: requestFactory(
      () => response('{"status":"idle"}'),
      observations,
    ),
  });
  try {
    const result = await transport.exchange(request());
    assert.equal(Buffer.from(result).toString('utf8'), '{"status":"idle"}');
    assert.equal(observations.options.protocol, 'https:');
    assert.equal(observations.options.hostname, 'cluster.example');
    assert.equal(observations.options.port, '7443');
    assert.equal(observations.options.minVersion, 'TLSv1.3');
    assert.equal(observations.options.rejectUnauthorized, true);
    assert.equal(observations.options.headers.authorization, AUTHORIZATION);
    assert.equal(observations.options.path, PATH);
    assert.equal(observations.timeout, 5_000);
    assert.deepEqual(JSON.parse(observations.body.toString('utf8')), request().body);
  } finally {
    transport.close();
  }
});

test('rejects plaintext origins, malformed credentials and oversized responses', async () => {
  assert.throws(
    () => new WorkerRemoteOfferHttpsTransport({
      origin: 'http://cluster.example',
      credentials: { async load() { return credentials(); } },
    }),
    /invalid_configuration/,
  );

  const malformed = new WorkerRemoteOfferHttpsTransport({
    origin: 'https://cluster.example',
    credentials: {
      async load() { return { ...credentials(), authorization: 'Bearer token' }; },
    },
    requestFactory: requestFactory(
      () => response('{}'),
      {},
    ),
  });
  await assert.rejects(malformed.exchange(request()), /credentials_unavailable/);
  malformed.close();

  const observations = {};
  const oversized = new WorkerRemoteOfferHttpsTransport({
    origin: 'https://cluster.example',
    credentials: { async load() { return credentials(); } },
    requestFactory: requestFactory(() => {
      const stream = new PassThrough();
      stream.statusCode = 200;
      stream.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => stream.end(Buffer.alloc(1025, 1)));
      return stream;
    }, observations),
  });
  await assert.rejects(oversized.exchange(request()), /response_too_large/);
  oversized.close();
});

test('propagates caller cancellation and refuses work after close', async () => {
  const transport = new WorkerRemoteOfferHttpsTransport({
    origin: 'https://cluster.example',
    credentials: { async load() { return credentials(); } },
    requestFactory: requestFactory(() => response('{}'), {}),
  });
  const controller = new AbortController();
  controller.abort(new Error('shutdown'));
  await assert.rejects(
    transport.exchange({ ...request(), signal: controller.signal }),
    /shutdown/,
  );
  transport.close();
  await assert.rejects(transport.exchange(request()), /closed/);
});
