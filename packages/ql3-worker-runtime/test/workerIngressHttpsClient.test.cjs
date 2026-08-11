'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  WORKER_INGRESS_ARTIFACT_CONTENT_TYPE,
  WorkerIngressHttpsClient,
} = require('../dist/remote-execution/transport/workerIngressHttpsClient');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const ARTIFACT_PATH =
  `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/artifacts`;
const COMPLETION_PATH =
  `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/completion`;
const AUTHORIZATION =
  `Worker ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}`;

function credentials() {
  return {
    authorization: AUTHORIZATION,
    certificateChainPem: 'client certificate',
    privateKeyPem: 'client private key',
    trustAnchors: ['trusted ca'],
  };
}

function response(body = '{"stored":true}') {
  const stream = new PassThrough();
  stream.statusCode = 200;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  queueMicrotask(() => stream.end(body));
  return stream;
}

function requestFactory(observation, options = {}) {
  return (requestOptions, callback) => {
    observation.options = requestOptions;
    observation.chunks = [];
    const outgoing = new EventEmitter();
    let writes = 0;
    outgoing.setTimeout = (timeout, handler) => {
      observation.timeout = timeout;
      observation.timeoutHandler = handler;
      return outgoing;
    };
    outgoing.write = (chunk) => {
      observation.chunks.push(Buffer.from(chunk));
      writes += 1;
      if (options.backpressure && writes === 1) {
        queueMicrotask(() => outgoing.emit('drain'));
        return false;
      }
      return true;
    };
    outgoing.end = () => {
      observation.ended = true;
      queueMicrotask(() => callback(response()));
    };
    outgoing.destroy = (error) => {
      observation.destroyed = true;
      if (error) queueMicrotask(() => outgoing.emit('error', error));
    };
    return outgoing;
  };
}

function client(observation, options = {}) {
  return new WorkerIngressHttpsClient({
    origin: 'https://cluster.example:7443',
    credentials: { async load() { return credentials(); } },
    requestTimeoutMs: 5_000,
    requestFactory: requestFactory(observation, options),
  });
}

test('streams exact Artifact bytes with bounded backpressure over shared mTLS', async () => {
  const observation = {};
  const transport = client(observation, { backpressure: true });
  const prefix = Buffer.from('header');
  const content = Buffer.from('worker-log');
  try {
    const result = await transport.postStream({
      path: ARTIFACT_PATH,
      body: (async function* () {
        yield prefix;
        yield content;
      })(),
      byteLength: prefix.byteLength + content.byteLength,
      maximumResponseBytes: 1024,
    });
    assert.equal(Buffer.from(result).toString('utf8'), '{"stored":true}');
    assert.equal(observation.options.protocol, 'https:');
    assert.equal(observation.options.hostname, 'cluster.example');
    assert.equal(observation.options.port, '7443');
    assert.equal(observation.options.minVersion, 'TLSv1.3');
    assert.equal(observation.options.rejectUnauthorized, true);
    assert.equal(observation.options.headers.authorization, AUTHORIZATION);
    assert.equal(
      observation.options.headers['content-type'],
      WORKER_INGRESS_ARTIFACT_CONTENT_TYPE,
    );
    assert.equal(
      observation.options.headers['content-length'],
      String(prefix.byteLength + content.byteLength),
    );
    assert.equal(Buffer.concat(observation.chunks).toString(), 'headerworker-log');
    assert.equal(observation.ended, true);
    assert.equal(observation.timeout, 5_000);
  } finally {
    transport.close();
  }
});

test('rejects short, overlong and route-confused stream bodies', async () => {
  const shortObservation = {};
  const short = client(shortObservation);
  try {
    await assert.rejects(
      short.postStream({
        path: ARTIFACT_PATH,
        body: (async function* () { yield Buffer.from('short'); })(),
        byteLength: 6,
        maximumResponseBytes: 1024,
      }),
      /request_rejected/,
    );
    assert.equal(shortObservation.destroyed, true);
  } finally {
    short.close();
  }

  const longObservation = {};
  const long = client(longObservation);
  try {
    await assert.rejects(
      long.postStream({
        path: ARTIFACT_PATH,
        body: (async function* () { yield Buffer.from('too-long'); })(),
        byteLength: 3,
        maximumResponseBytes: 1024,
      }),
      /request_rejected/,
    );
    await assert.rejects(
      long.postStream({
        path: COMPLETION_PATH,
        body: (async function* () { yield Buffer.from('{}'); })(),
        byteLength: 2,
        maximumResponseBytes: 1024,
      }),
      /request_rejected/,
    );
    await assert.rejects(
      long.postJson({
        path: ARTIFACT_PATH,
        body: {},
        maximumResponseBytes: 1024,
      }),
      /request_rejected/,
    );
  } finally {
    long.close();
  }
});

test('permits completion JSON while keeping Artifact transport stream-only', async () => {
  const observation = {};
  const transport = client(observation);
  const originalFactory = observation;
  try {
    // A separate JSON-capable fake keeps this assertion focused on route policy.
    const json = new WorkerIngressHttpsClient({
      origin: 'https://cluster.example',
      credentials: { async load() { return credentials(); } },
      requestFactory(options, callback) {
        originalFactory.options = options;
        const outgoing = new EventEmitter();
        outgoing.setTimeout = () => outgoing;
        outgoing.destroy = (error) => {
          if (error) queueMicrotask(() => outgoing.emit('error', error));
        };
        outgoing.end = (body) => {
          originalFactory.body = Buffer.from(body);
          queueMicrotask(() => callback(response('{"status":"applied"}')));
        };
        return outgoing;
      },
    });
    try {
      await json.postJson({
        path: COMPLETION_PATH,
        body: { schema: 'qinglong/remote-worker-completion@v1' },
        maximumResponseBytes: 1024,
      });
      assert.equal(originalFactory.options.path, COMPLETION_PATH);
    } finally {
      json.close();
    }
  } finally {
    transport.close();
  }
});

test('disposes provider-owned credential material on success and rejection', async () => {
  const certificate = Buffer.from('client certificate');
  const privateKey = Buffer.from('client private key');
  const trust = Buffer.from('trusted ca');
  let disposals = 0;
  const observation = {};
  const transport = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example',
    credentials: {
      async load() {
        return {
          authorization: AUTHORIZATION,
          certificateChainPem: certificate,
          privateKeyPem: privateKey,
          trustAnchors: [trust],
          dispose() {
            disposals += 1;
            certificate.fill(0);
            privateKey.fill(0);
            trust.fill(0);
          },
        };
      },
    },
    requestFactory: requestFactory(observation),
  });
  try {
    await transport.postJson({
      path: COMPLETION_PATH,
      body: { schema: 'qinglong/remote-worker-completion@v1' },
      maximumResponseBytes: 1024,
    });
    assert.equal(disposals, 1);
    assert.equal(certificate.equals(Buffer.alloc(certificate.length)), true);
    assert.equal(privateKey.equals(Buffer.alloc(privateKey.length)), true);
    assert.equal(trust.equals(Buffer.alloc(trust.length)), true);
  } finally {
    transport.close();
  }

  let rejectedDisposals = 0;
  const rejected = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example',
    credentials: {
      async load() {
        return {
          authorization: 'invalid',
          certificateChainPem: 'certificate',
          privateKeyPem: 'key',
          trustAnchors: ['trust'],
          dispose() { rejectedDisposals += 1; },
        };
      },
    },
    requestFactory() { throw new Error('request must not start'); },
  });
  try {
    await assert.rejects(
      rejected.postJson({
        path: COMPLETION_PATH,
        body: {},
        maximumResponseBytes: 1024,
      }),
      /credentials_unavailable/,
    );
    assert.equal(rejectedDisposals, 1);
  } finally {
    rejected.close();
  }
});

test('exposes only the low-sensitive non-success HTTP status class', async () => {
  const transport = new WorkerIngressHttpsClient({
    origin: 'https://cluster.example',
    credentials: { async load() { return credentials(); } },
    requestFactory(_options, callback) {
      const outgoing = new EventEmitter();
      outgoing.setTimeout = () => outgoing;
      outgoing.destroy = (error) => {
        if (error) queueMicrotask(() => outgoing.emit('error', error));
      };
      outgoing.end = () => {
        const denied = response('{"code":"must-not-be-read"}');
        denied.statusCode = 401;
        queueMicrotask(() => callback(denied));
      };
      return outgoing;
    },
  });
  try {
    await assert.rejects(
      transport.postJson({
        path: COMPLETION_PATH,
        body: {},
        maximumResponseBytes: 1024,
      }),
      (error) =>
        error.reason === 'response_rejected' && error.httpStatus === 401,
    );
  } finally {
    transport.close();
  }
});
