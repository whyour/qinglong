const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { request: httpsRequest } = require('node:https');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterPluginPackageIdentityKeysetUnavailableError,
} = require('@qinglong/cluster-admin/plugin-package-identity-keyset');
const {
  ClusterPluginPackageManagementHttpConfigurationError,
  startClusterPluginPackageManagementHttp,
} = require('@qinglong/cluster-admin/plugin-package-management-http');
const {
  PluginPackageManagementQuotaExceededError,
} = require('@qinglong/runtime-core/plugin-package-management');

const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);

function principal() {
  return {
    subject: { type: 'user', id: 'cluster-reviewer' },
    authenticationId: 'ql3oidc.authentication-id',
    authenticatedAtMs: 900,
    expiresAtMs: 10_000,
    assurance: 'multi_factor',
  };
}

function command() {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.inspect',
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      inspectionId: 'inspection-cluster-monitor-1',
    },
  };
}

function identityProvider(overrides = {}) {
  const calls = {
    reload: 0,
    bind: [],
    authenticate: 0,
  };
  return {
    calls,
    provider: {
      async reload() {
        calls.reload += 1;
        return {
          schemaVersion: 1,
          generation: 1,
          digest: 'digest',
          issuer: 'https://identity.example.test/',
          audience: 'qinglong3-package-management',
          activeKeyIds: ['key-1'],
          revokedKeyIds: [],
        };
      },
      bind(assertion) {
        calls.bind.push(assertion);
        return {
          async authenticate() {
            calls.authenticate += 1;
            if (overrides.authenticate) {
              return overrides.authenticate();
            }
            return principal();
          },
        };
      },
    },
  };
}

function transportFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    transport: {
      async execute(value, authentication) {
        calls.push({
          command: value,
          principal: await authentication.authenticate(),
        });
        if (overrides.execute) return overrides.execute(value);
        return {
          schemaVersion: 1,
          operation: 'plugin-package.inspect',
          proposal: null,
          approval: null,
        };
      },
    },
  };
}

async function startFixture(overrides = {}) {
  const identities = overrides.identities ?? identityProvider();
  const transport = overrides.transport ?? transportFixture();
  const privateKey = Buffer.from(readFileSync(SERVER_KEY));
  const application = await startClusterPluginPackageManagementHttp({
    host: '127.0.0.1',
    port: 0,
    tls: {
      privateKey,
      certificate: Buffer.from(readFileSync(SERVER_CERT)),
    },
    identities: identities.provider,
    transport: transport.transport,
    limits: {
      requestTimeoutMs: 2_000,
      drainTimeoutMs: 500,
      ...(overrides.limits ?? {}),
    },
    now: overrides.now ?? (() => 1_000),
    createRequestId: overrides.createRequestId ?? (() => 'request-1'),
    onError: overrides.onError,
  });
  assert.equal(
    privateKey.every((value) => value === 0),
    true,
  );
  return { application, identities, transport };
}

async function request(application, options = {}) {
  const body =
    options.body === undefined
      ? Buffer.from(JSON.stringify(command()))
      : Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(options.body);
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest(
      {
        host: '127.0.0.1',
        port: application.address.port,
        path: options.path ?? '/api/v3/plugin-packages/management',
        method: options.method ?? 'POST',
        rejectUnauthorized: false,
        agent: false,
        headers: {
          ...(options.authorization === false
            ? {}
            : { authorization: 'Bearer assertion-value' }),
          ...(options.contentType === false
            ? {}
            : { 'content-type': 'application/json' }),
          ...(options.omitLength
            ? {}
            : { 'content-length': String(body.length) }),
          ...(options.headers ?? {}),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('end', () => {
          const bytes = Buffer.concat(chunks);
          resolvePromise({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            body:
              bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8')),
          });
        });
      },
    );
    outgoing.once('error', reject);
    if (body.length > 0) outgoing.write(body);
    outgoing.end();
  });
}

test('rejects request and connection ceilings above hard bounds', async () => {
  for (const limits of [
    { maxBodyBytes: 256 * 1024 + 1 },
    { maxConnections: 513 },
  ]) {
    const privateKey = Buffer.from(readFileSync(SERVER_KEY));
    try {
      await assert.rejects(
        startClusterPluginPackageManagementHttp({
          host: '127.0.0.1',
          port: 0,
          tls: {
            privateKey,
            certificate: Buffer.from(readFileSync(SERVER_CERT)),
          },
          identities: identityProvider().provider,
          transport: transportFixture().transport,
          limits,
        }),
        ClusterPluginPackageManagementHttpConfigurationError,
      );
    } finally {
      privateKey.fill(0);
    }
  }
});

test('serves health and authenticates before one exact management command', async () => {
  const fixture = await startFixture();
  try {
    const live = await request(fixture.application, {
      method: 'GET',
      path: '/livez',
      body: Buffer.alloc(0),
      authorization: false,
      contentType: false,
    });
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers['x-request-id'], 'request-1');
    assert.equal(live.headers['cache-control'], 'no-store');
    assert.deepEqual(live.body, { schemaVersion: 1, status: 'live' });
    const response = await request(fixture.application);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.result.operation, 'plugin-package.inspect');
    assert.deepEqual(fixture.identities.calls.bind, ['assertion-value']);
    assert.equal(fixture.identities.calls.authenticate, 1);
    assert.equal(fixture.transport.calls.length, 1);
    assert.deepEqual(fixture.transport.calls[0].command, command());
    assert.deepEqual(fixture.transport.calls[0].principal.subject, {
      type: 'user',
      id: 'cluster-reviewer',
    });
  } finally {
    await fixture.application.close();
  }
});

test('maps durable quota exhaustion to 429 with a bounded Retry-After', async () => {
  const fixture = await startFixture({
    transport: transportFixture({
      async execute() {
        throw new PluginPackageManagementQuotaExceededError(1_250);
      },
    }),
  });
  try {
    const response = await request(fixture.application);
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '2');
    assert.equal(response.body.error.code, 'quota_exceeded');
  } finally {
    await fixture.application.close();
  }
});

test('rejects routes, missing authentication and media type before transport', async () => {
  const fixture = await startFixture();
  try {
    assert.equal(
      (
        await request(fixture.application, {
          path: '/api/v3/plugin-packages/unknown',
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await request(fixture.application, { authorization: false })).statusCode,
      401,
    );
    assert.equal(
      (await request(fixture.application, { contentType: false })).statusCode,
      415,
    );
    assert.equal(
      (
        await request(fixture.application, {
          headers: { expect: '100-continue' },
        })
      ).statusCode,
      417,
    );
    assert.equal(fixture.transport.calls.length, 0);
    assert.equal(fixture.identities.calls.authenticate, 1);
  } finally {
    await fixture.application.close();
  }
});

test('fails closed when the live keyset is unavailable', async () => {
  const identities = identityProvider({
    authenticate() {
      throw new ClusterPluginPackageIdentityKeysetUnavailableError();
    },
  });
  const fixture = await startFixture({ identities });
  try {
    const response = await request(fixture.application);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error.code, 'unavailable');
    assert.equal(fixture.transport.calls.length, 0);
  } finally {
    await fixture.application.close();
  }
});

test('enforces peer limits before authentication with bounded retry evidence', async () => {
  const fixture = await startFixture({
    limits: {
      rateWindowMs: 60_000,
      peerRequestLimit: 1,
      globalRequestLimit: 10,
      maxRateLimitPeers: 2,
    },
  });
  try {
    assert.equal((await request(fixture.application)).statusCode, 200);
    const limited = await request(fixture.application);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal(fixture.identities.calls.authenticate, 1);
    assert.equal(fixture.transport.calls.length, 1);
  } finally {
    await fixture.application.close();
  }
});

test('bounds request bodies and concurrent management work', async () => {
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const fixture = await startFixture({
    limits: {
      maxBodyBytes: 1_024,
      maxConcurrentRequests: 1,
    },
    transport: transportFixture({
      async execute() {
        await gate;
        return {
          schemaVersion: 1,
          operation: 'plugin-package.inspect',
          proposal: null,
          approval: null,
        };
      },
    }),
  });
  try {
    assert.equal(
      (
        await request(fixture.application, {
          body: Buffer.alloc(1_025, 0x20),
        })
      ).statusCode,
      413,
    );
    const first = request(fixture.application);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const overloaded = await request(fixture.application);
    assert.equal(overloaded.statusCode, 503);
    assert.equal(overloaded.body.error.code, 'overloaded');
    release();
    assert.equal((await first).statusCode, 200);
  } finally {
    release();
    await fixture.application.close();
  }
});

test('withdraws readiness without killing liveness and closes idempotently', async () => {
  const fixture = await startFixture();
  fixture.application.withdraw(new Error('database unavailable'));
  assert.equal(fixture.application.availabilityStatus(), 'unavailable');
  assert.equal(
    (
      await request(fixture.application, {
        method: 'GET',
        path: '/readyz',
        body: Buffer.alloc(0),
        authorization: false,
        contentType: false,
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (
      await request(fixture.application, {
        method: 'GET',
        path: '/livez',
        body: Buffer.alloc(0),
        authorization: false,
        contentType: false,
      })
    ).statusCode,
    200,
  );
  assert.equal((await request(fixture.application)).statusCode, 503);
  await Promise.all([fixture.application.close(), fixture.application.close()]);
  assert.equal(fixture.application.availabilityStatus(), 'stopped');
});
