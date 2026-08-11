const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { test } = require('node:test');
const {
  ClusterControlAdmissionDrainTimeoutError,
  ClusterControlHttpConfigurationError,
  startClusterControlHttpSurface,
} = require('@qinglong/cluster-control/http');

const EVIDENCE = Object.freeze({
  contractName: 'control-core',
  contractVersion: 2,
  serverMajor: 16,
  migrationIds: Object.freeze([
    'pg-0001-schema-capability',
    'pg-0002-run-core',
    'pg-0003-run-retry-policy',
  ]),
});
const MTLS_FIXTURES = path.join(__dirname, 'fixtures', 'mtls');
const MTLS = Object.freeze({
  privateKey: readFileSync(path.join(MTLS_FIXTURES, 'server-key.pem')),
  certificateChain: readFileSync(path.join(MTLS_FIXTURES, 'server-cert.pem')),
  clientCertificateAuthorities: Object.freeze([
    readFileSync(path.join(MTLS_FIXTURES, 'ca-cert.pem')),
  ]),
});

function pipeline(handler) {
  return {
    async prepare(metadata) {
      return {
        handle(body) {
          return handler({ ...metadata, body });
        },
      };
    },
  };
}

function request(address, options = {}) {
  const rawBody = options.rawBody;
  const body =
    rawBody === undefined
      ? options.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(options.body))
      : Buffer.from(rawBody);
  const headers = { connection: 'close', ...options.headers };
  if (body && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }
  if (options.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: address.host,
        port: address.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: text.length === 0 ? null : JSON.parse(text),
          });
        });
      },
    );
    outgoing.on('error', reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function secureRequest(address, withClientCertificate, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request(
      {
        host: '127.0.0.1',
        servername: 'localhost',
        port: address.port,
        path: options.path ?? '/livez',
        method: options.method ?? 'GET',
        agent: options.agent,
        ca: readFileSync(path.join(MTLS_FIXTURES, 'ca-cert.pem')),
        ...(withClientCertificate
          ? {
              key: readFileSync(path.join(MTLS_FIXTURES, 'client-key.pem')),
              cert: readFileSync(path.join(MTLS_FIXTURES, 'client-cert.pem')),
            }
          : {}),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
      },
      (response) => {
        const tlsProtocol = response.socket.getProtocol();
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            tlsProtocol,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('requires a trusted client certificate on the TLS 1.3 surface', async (t) => {
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    mutualTls: MTLS,
  });
  t.after(() => surface.close());

  await assert.rejects(secureRequest(surface.address, false));
  const trusted = await secureRequest(surface.address, true);
  assert.equal(trusted.statusCode, 200);
  assert.equal(trusted.tlsProtocol, 'TLSv1.3');
  assert.deepEqual(trusted.body, { status: 'live' });
});

test('reloads mTLS trust and CRLs without rebinding the listener', async (t) => {
  const emptyCrl = readFileSync(path.join(MTLS_FIXTURES, 'empty-crl.pem'));
  const revokedClientCrl = readFileSync(
    path.join(MTLS_FIXTURES, 'revoked-client-crl.pem'),
  );
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    mutualTls: {
      ...MTLS,
      certificateRevocationLists: [emptyCrl],
    },
  });
  t.after(() => surface.close());
  const address = { ...surface.address };

  assert.equal((await secureRequest(address, true)).statusCode, 200);
  assert.equal(
    surface.reloadMutualTls({
      ...MTLS,
      certificateRevocationLists: [revokedClientCrl],
    }),
    2,
  );
  assert.deepEqual(surface.address, address);
  await assert.rejects(secureRequest(address, true));

  assert.equal(
    surface.reloadMutualTls({
      ...MTLS,
      certificateRevocationLists: [emptyCrl],
    }),
    3,
  );
  assert.equal((await secureRequest(address, true)).statusCode, 200);

  assert.throws(
    () =>
      surface.reloadMutualTls({
        ...MTLS,
        certificateChain: 'not a certificate',
        certificateRevocationLists: [emptyCrl],
      }),
    ClusterControlHttpConfigurationError,
  );
  assert.equal((await secureRequest(address, true)).statusCode, 200);
});

test('forces pre-reload keep-alive sockets to reconnect before routing', async (t) => {
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    mutualTls: MTLS,
  });
  t.after(() => surface.close());
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  const dispose = surface.installAdmission(
    EVIDENCE,
    pipeline(async () => {
      entered();
      await releasePromise;
      return { statusCode: 200, body: { status: 'completed' } };
    }),
  );
  t.after(() => dispose());

  const active = secureRequest(surface.address, true, {
    agent,
    path: '/api/v3/hold',
  });
  await enteredPromise;
  assert.equal(surface.reloadMutualTls(MTLS), 2);
  release();
  assert.equal((await active).statusCode, 200);

  const stale = await secureRequest(surface.address, true, { agent });
  assert.equal(stale.statusCode, 503);
  assert.deepEqual(stale.body, { code: 'tls_context_reloaded' });
  assert.equal(stale.headers.connection, 'close');
  assert.equal(
    (await secureRequest(surface.address, true, { agent })).statusCode,
    200,
  );
});

test('exposes probes but rejects API work until admission is installed', async (t) => {
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => surface.close());

  const live = await request(surface.address, { path: '/livez' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.body, { status: 'live' });
  assert.equal(live.headers['cache-control'], 'no-store');
  const invalidProbeMethod = await request(surface.address, {
    method: 'POST',
    path: '/livez',
  });
  assert.equal(invalidProbeMethod.statusCode, 405);
  assert.deepEqual(invalidProbeMethod.body, { code: 'method_not_allowed' });
  const waiting = await request(surface.address, { path: '/readyz' });
  assert.equal(waiting.statusCode, 503);
  assert.deepEqual(waiting.body, { status: 'not_ready' });
  const rejected = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/runs',
    headers: { connection: 'keep-alive' },
    body: { mustNotBeRead: true },
  });
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.headers.connection, 'close');

  let observed;
  const dispose = surface.installAdmission(
    EVIDENCE,
    pipeline(async (incoming) => {
      observed = incoming;
      return { statusCode: 201, body: { accepted: true } };
    }),
  );
  const ready = await request(surface.address, { path: '/readyz' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.body, { status: 'ready' });
  const admitted = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/runs?tag=a&tag=b',
    headers: { 'x-request-id': 'request-123' },
    body: { taskId: 'task-1' },
  });
  assert.equal(admitted.statusCode, 201);
  assert.deepEqual(admitted.body, { accepted: true });
  assert.equal(admitted.headers['x-request-id'], 'request-123');
  assert.equal(observed.requestId, 'request-123');
  assert.equal(observed.method, 'POST');
  assert.equal(observed.path, '/api/v3/runs');
  assert.deepEqual(observed.query.tag, ['a', 'b']);
  assert.deepEqual(observed.body, { taskId: 'task-1' });

  await dispose();
  assert.equal(
    (await request(surface.address, { path: '/readyz' })).statusCode,
    503,
  );
  assert.equal(
    (
      await request(surface.address, {
        method: 'POST',
        path: '/api/v3/runs',
        body: { ignored: true },
      })
    ).statusCode,
    503,
  );
});

test('enforces bounded JSON requests and responses without leaking failures', async (t) => {
  const diagnostics = [];
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 1024,
    maxResponseBytes: 1024,
    onError(diagnostic) {
      diagnostics.push(diagnostic);
    },
  });
  t.after(() => surface.close());
  const dispose = surface.installAdmission(
    EVIDENCE,
    pipeline(async (incoming) => {
      if (incoming.path.endsWith('/large')) {
        return { statusCode: 200, body: { value: 'x'.repeat(2048) } };
      }
      if (incoming.path.endsWith('/throw')) {
        throw new Error('secret driver detail');
      }
      return { statusCode: 200, body: incoming.body };
    }),
  );
  t.after(() => dispose());

  const invalidJson = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/test',
    headers: { 'content-type': 'application/json' },
    rawBody: '{',
  });
  assert.equal(invalidJson.statusCode, 400);
  assert.deepEqual(invalidJson.body, { code: 'invalid_json' });

  const unsupported = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/test',
    headers: { 'content-type': 'text/plain' },
    rawBody: 'hello',
  });
  assert.equal(unsupported.statusCode, 415);
  assert.deepEqual(unsupported.body, { code: 'unsupported_content_type' });

  const oversized = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/test',
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify({ value: 'x'.repeat(1024) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(oversized.body, { code: 'request_too_large' });

  const largeResponse = await request(surface.address, {
    path: '/api/v3/large',
  });
  assert.equal(largeResponse.statusCode, 500);
  assert.deepEqual(largeResponse.body, { code: 'response_too_large' });

  const internal = await request(surface.address, {
    path: '/api/v3/throw',
  });
  assert.equal(internal.statusCode, 500);
  assert.deepEqual(internal.body, { code: 'internal_error' });
  assert.equal(
    JSON.stringify(internal).includes('secret driver detail'),
    false,
  );
  assert.equal(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.phase === 'request' && diagnostic.path === '/api/v3/throw',
    ),
    true,
  );
});

test('completes admission preflight before reading an untrusted body', async (t) => {
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => surface.close());
  const dispose = surface.installAdmission(EVIDENCE, {
    async prepare() {
      throw Object.assign(new Error('credential rejected'), {
        statusCode: 401,
        code: 'authentication_required',
      });
    },
  });
  t.after(() => dispose());

  const rejected = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/runs',
    headers: {
      connection: 'keep-alive',
      'content-type': 'application/json',
      'content-length': String(1024 * 1024),
    },
  });
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.body, { code: 'authentication_required' });
  assert.equal(rejected.headers.connection, 'close');
});

test('streams one route-bounded body without widening the JSON body cap', async (t) => {
  const observations = [];
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 1024,
  });
  t.after(() => surface.close());
  const dispose = surface.installAdmission(EVIDENCE, {
    async prepare(metadata) {
      observations.push(`prepare:${metadata.path}`);
      return {
        bodyMode: 'stream',
        contentType: 'application/vnd.qinglong.worker-artifact',
        maximumBodyBytes: 8 * 1024,
        async handleStream(body) {
          observations.push(`handle:${body.contentLength}`);
          let total = 0;
          let chunks = 0;
          for await (const chunk of body.chunks) {
            total += chunk.byteLength;
            chunks += 1;
          }
          return {
            statusCode: 200,
            body: { total, chunks, contentType: body.contentType },
          };
        },
      };
    },
  });
  t.after(() => dispose());

  const bytes = Buffer.alloc(4 * 1024, 7);
  const result = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/worker-ingress/artifacts',
    headers: {
      'content-type': 'application/vnd.qinglong.worker-artifact',
    },
    rawBody: bytes,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    total: bytes.byteLength,
    chunks: 1,
    contentType: 'application/vnd.qinglong.worker-artifact',
  });
  assert.deepEqual(observations, [
    'prepare:/api/v3/worker-ingress/artifacts',
    `handle:${bytes.byteLength}`,
  ]);
});

test('rejects invalid stream envelopes and incomplete consumption', async (t) => {
  let handles = 0;
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => surface.close());
  const dispose = surface.installAdmission(EVIDENCE, {
    async prepare() {
      return {
        bodyMode: 'stream',
        contentType: 'application/vnd.qinglong.worker-artifact',
        maximumBodyBytes: 1024,
        async handleStream() {
          handles += 1;
          return { statusCode: 200, body: { accepted: true } };
        },
      };
    },
  });
  t.after(() => dispose());

  const oversized = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/worker-ingress/artifacts',
    headers: {
      'content-type': 'application/vnd.qinglong.worker-artifact',
      'content-length': '1025',
    },
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(oversized.body, { code: 'request_too_large' });
  assert.equal(handles, 0);

  const unsupported = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/worker-ingress/artifacts',
    headers: { 'content-type': 'application/octet-stream' },
    rawBody: 'log',
  });
  assert.equal(unsupported.statusCode, 415);
  assert.deepEqual(unsupported.body, { code: 'unsupported_content_type' });
  assert.equal(handles, 0);

  const incomplete = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/worker-ingress/artifacts',
    headers: {
      'content-type': 'application/vnd.qinglong.worker-artifact',
    },
    rawBody: 'log',
  });
  assert.equal(incomplete.statusCode, 500);
  assert.deepEqual(incomplete.body, { code: 'internal_error' });
  assert.equal(incomplete.headers.connection, 'close');
  assert.equal(handles, 1);
});

test('refunds successful admission and limits failed preflight before body reads', async (t) => {
  const events = [];
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    authenticationRatePerPeer: 1,
    authenticationRateGlobal: 10,
    authenticationRateMaxPeers: 4,
    onAuthenticationShieldEvent(event) {
      events.push(event);
    },
  });
  t.after(() => surface.close());

  const beforeRead = await request(surface.address, {
    path: '/api/v3/test',
    headers: { 'x-forwarded-for': '198.51.100.10' },
  });
  assert.equal(beforeRead.statusCode, 503);
  assert.deepEqual(beforeRead.body, { code: 'not_ready' });

  let prepares = 0;
  const dispose = surface.installAdmission(EVIDENCE, {
    async prepare(metadata) {
      prepares += 1;
      if (metadata.path === '/api/v3/rejected') {
        throw Object.assign(new Error('authentication failed'), {
          statusCode: 401,
          code: 'authentication_required',
        });
      }
      return { handle: () => ({ statusCode: 204 }) };
    },
  });
  t.after(() => dispose());

  const admitted = await request(surface.address, {
    path: '/api/v3/test',
    headers: { 'x-forwarded-for': '198.51.100.11' },
  });
  assert.equal(admitted.statusCode, 204);
  assert.equal(prepares, 1);

  const rejected = await request(surface.address, {
    path: '/api/v3/rejected',
  });
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.body, { code: 'authentication_required' });
  assert.equal(prepares, 2);

  const limited = await request(surface.address, {
    method: 'POST',
    path: '/api/v3/rejected',
    headers: {
      connection: 'keep-alive',
      'content-type': 'application/json',
      'content-length': String(1024 * 1024),
      'x-forwarded-for': '203.0.113.99',
    },
  });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.body, { code: 'authentication_rate_limited' });
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.headers.connection, 'close');
  assert.equal(prepares, 2);
  assert.deepEqual(events, [{ outcome: 'rate_limited', reason: 'peer' }]);

  const probe = await request(surface.address, { path: '/livez' });
  assert.equal(probe.statusCode, 200);
});

test('withdraws admission immediately and drains in-flight requests', async (t) => {
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    maxInFlightRequests: 1,
    drainTimeoutMs: 1000,
  });
  t.after(() => surface.close());
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const dispose = surface.installAdmission(
    EVIDENCE,
    pipeline(async () => {
      entered();
      await gate;
      return { statusCode: 200, body: { completed: true } };
    }),
  );

  const first = request(surface.address, { path: '/api/v3/slow' });
  await enteredPromise;
  const capacity = await request(surface.address, { path: '/api/v3/second' });
  assert.equal(capacity.statusCode, 503);
  assert.deepEqual(capacity.body, { code: 'admission_capacity_exhausted' });

  let drained = false;
  const draining = dispose().then(() => {
    drained = true;
  });
  assert.equal(
    (await request(surface.address, { path: '/readyz' })).statusCode,
    503,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  const withdrawn = await first;
  assert.equal(withdrawn.statusCode, 503);
  assert.deepEqual(withdrawn.body, { code: 'admission_draining' });
  await draining;
  assert.equal(drained, true);
});

test('reports a drain timeout when a handler ignores cancellation', async (t) => {
  const surface = await startClusterControlHttpSurface({
    host: '127.0.0.1',
    port: 0,
    drainTimeoutMs: 100,
  });
  t.after(() => surface.close());
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const dispose = surface.installAdmission(
    EVIDENCE,
    pipeline(async () => {
      entered();
      await new Promise(() => {});
      return { statusCode: 200 };
    }),
  );
  const response = request(surface.address, { path: '/api/v3/stuck' });
  await enteredPromise;
  await assert.rejects(dispose(), ClusterControlAdmissionDrainTimeoutError);
  const timedOut = await response;
  assert.equal(timedOut.statusCode, 503);
  assert.deepEqual(timedOut.body, { code: 'admission_draining' });
});

test('rejects unsafe listener and resource configurations before binding', async () => {
  const plaintext = await startClusterControlHttpSurface({ port: 0 });
  await assert.rejects(
    Promise.resolve().then(() => plaintext.reloadMutualTls(MTLS)),
    /does not use mutual TLS/,
  );
  await plaintext.close();
  await assert.rejects(
    startClusterControlHttpSurface({
      port: 0,
      mutualTls: {
        ...MTLS,
        certificateRevocationLists: [
          '-----BEGIN X509 CRL-----\ninvalid\n-----END X509 CRL-----',
        ],
      },
    }),
    ClusterControlHttpConfigurationError,
  );
  await assert.rejects(
    startClusterControlHttpSurface({ host: '0.0.0.0;bad', port: 0 }),
    ClusterControlHttpConfigurationError,
  );
  await assert.rejects(
    startClusterControlHttpSurface({
      port: 0,
      maxInFlightRequests: 1025,
    }),
    ClusterControlHttpConfigurationError,
  );
  await assert.rejects(
    startClusterControlHttpSurface({
      port: 0,
      authenticationRateMaxPeers: 65_537,
    }),
    ClusterControlHttpConfigurationError,
  );
});
