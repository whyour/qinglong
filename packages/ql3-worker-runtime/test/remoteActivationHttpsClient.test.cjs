'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  WorkerIngressHttpsClient,
  WorkerRemoteExecutionHttpsActivationClient,
  WorkerRemoteOfferHttpsTransport,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const AUTHORIZATION =
  `Worker ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}`;

function response(body) {
  const serialized = JSON.stringify(body);
  const stream = new PassThrough();
  stream.statusCode = 200;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(serialized)),
  };
  queueMicrotask(() => stream.end(serialized));
  return stream;
}

function responseBody(overrides = {}) {
  return {
    schema: 'qinglong/remote-run-activation@v1',
    status: 'applied',
    snapshot: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      runStatus: 'dispatching',
      attemptStatus: 'starting',
      leaseVersion: 4,
      leaseGeneration: 3,
      callbackSequence: 0,
    },
    ...overrides,
  };
}

function responseBodyForPath(requestPath) {
  if (requestPath.endsWith('/offers')) return { status: 'idle' };
  if (requestPath.endsWith('/running')) {
    return responseBody({
      snapshot: {
        ...responseBody().snapshot,
        runStatus: 'running',
        attemptStatus: 'running',
        callbackSequence: 1,
        executorHandle: 'remote:handle-1',
        startedAtMs: 20_000,
      },
    });
  }
  if (requestPath.endsWith('/start-failure')) {
    return responseBody({
      snapshot: {
        ...responseBody().snapshot,
        runStatus: 'failed',
        attemptStatus: 'failed',
        leaseVersion: 5,
        callbackSequence: 1,
        finishedAtMs: 20_000,
        errorCode: 'EXECUTOR_START_FAILED',
      },
    });
  }
  return responseBody();
}

function requestFactory(observations, responseFactory = responseBodyForPath) {
  return (options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = (body) => {
      observations.push({
        agent: options.agent,
        path: options.path,
        body: JSON.parse(Buffer.from(body).toString('utf8')),
      });
      queueMicrotask(() => callback(response(responseFactory(options.path))));
    };
    return request;
  };
}

function credentials() {
  return {
    authorization: AUTHORIZATION,
    certificateChainPem: 'client certificate',
    privateKeyPem: 'client private key',
    trustAnchors: ['trusted ca'],
  };
}

function command() {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
    expectedLeaseVersion: 4,
  };
}

test('shares one Agent and credential authority across offer and activation calls', async () => {
  const observations = [];
  const shared = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example:7443',
    credentials: { async load() { return credentials(); } },
    requestFactory: requestFactory(observations),
  });
  const offers = new WorkerRemoteOfferHttpsTransport({ client: shared });
  const activation = new WorkerRemoteExecutionHttpsActivationClient({
    client: shared,
  });
  try {
    await offers.exchange({
      path: `/api/v3/worker-ingress/workers/edge-1/sessions/${SESSION_ID}/offers`,
      body: {
        workerGeneration: 2,
        offerId: 'offer-1',
        leaseToken: command().leaseToken,
      },
      maximumResponseBytes: 1024,
    });
    offers.close();
    await activation.acknowledgeStarting({
      ...command(),
      eventId: '018f0000-0000-7000-8000-000000000002',
    });
    await activation.acknowledgeRunning({
      ...command(),
      attemptEventId: '018f0000-0000-7000-8000-000000000003',
      runEventId: '018f0000-0000-7000-8000-000000000004',
      executorHandle: 'remote:handle-1',
      callbackSequence: 1,
      callbackTokenDigest: 'a'.repeat(64),
    });
    await activation.failStart({
      ...command(),
      attemptEventId: '018f0000-0000-7000-8000-000000000005',
      runEventId: '018f0000-0000-7000-8000-000000000006',
    });
    await shared.postJson({
      path: `/api/v3/worker-ingress/workers/edge-1/sessions/${SESSION_ID}/secrets`,
      body: { probe: true },
      maximumResponseBytes: 16 * 1024,
    });
    assert.equal(new Set(observations.map((item) => item.agent)).size, 1);
    assert.deepEqual(observations.map((item) => item.path.split('/').at(-1)), [
      'offers', 'starting', 'running', 'start-failure', 'secrets',
    ]);
    assert.equal('eventId' in observations[1].body, false);
    assert.equal('workerId' in observations[1].body, false);
    assert.equal('workerSessionId' in observations[1].body, false);
    assert.equal(observations[2].body.logArtifactId, null);
  } finally {
    shared.close();
  }
});

test('rejects a response whose run authority does not match the request', async () => {
  const shared = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example',
    credentials: { async load() { return credentials(); } },
    requestFactory: requestFactory([], () => responseBody({
      snapshot: { ...responseBody().snapshot, runId: 'run-other' },
    })),
  });
  const activation = new WorkerRemoteExecutionHttpsActivationClient({
    client: shared,
  });
  try {
    await assert.rejects(
      activation.acknowledgeStarting({
        ...command(),
        eventId: '018f0000-0000-7000-8000-000000000002',
      }),
      /response_invalid/,
    );
  } finally {
    shared.close();
  }
});

test('keeps 4 KiB as the default body cap and permits bounded Secret batches explicitly', async () => {
  const observations = [];
  const shared = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example',
    credentials: { async load() { return credentials(); } },
    requestFactory: requestFactory(observations, () => ({ ok: true })),
  });
  const path = `/api/v3/worker-ingress/workers/edge-1/sessions/${SESSION_ID}/secrets`;
  const body = { value: 'x'.repeat(5 * 1024) };
  try {
    await assert.rejects(
      shared.postJson({ path, body, maximumResponseBytes: 1024 }),
      /request_rejected/,
    );
    await shared.postJson({
      path, body, maximumRequestBytes: 64 * 1024, maximumResponseBytes: 1024,
    });
    assert.equal(observations.length, 1);
  } finally {
    shared.close();
  }
});
