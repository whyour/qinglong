const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { request: httpsRequest } = require('node:https');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterPluginPackageManagementHttpConfigurationError,
  startClusterPluginPackageManagementHttp,
} = require('@qinglong/cluster-admin/plugin-package-management-http');
const {
  startClusterWorkerCredentialManagementHttp,
} = require('@qinglong/cluster-admin/worker-credential-management-http');
const {
  WorkerCredentialManagementAuthorizationError,
  WorkerCredentialManagementConflictError,
  WorkerCredentialManagementQuotaExceededError,
  WorkerCredentialManagementRequestError,
  WorkerCredentialManagementUnavailableError,
} = require('@qinglong/cluster-admin/worker-credential-management');

const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);
const CLIENT_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/client-key.pem',
);
const CLIENT_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/client-cert.pem',
);
const CLIENT_CA = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const EMPTY_CRL = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/empty-crl.pem',
);
const REVOKED_CLIENT_CRL = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/revoked-client-crl.pem',
);
const NEXT_CLIENT_CA = resolve(
  __dirname,
  'fixtures/next-client-ca-cert.pem',
);
const NEXT_CLIENT_CRL = resolve(
  __dirname,
  'fixtures/next-client-empty-crl.pem',
);
const NEXT_CLIENT_CERT = resolve(
  __dirname,
  'fixtures/next-client-cert.pem',
);
const NEXT_CLIENT_KEY = resolve(
  __dirname,
  'fixtures/next-client-key.pem',
);
const WORKER_PATH = '/api/v3/worker-credentials/management';
const CANONICAL_WORKER_PATH = '/api/v3/workers/management';

function command() {
  return {
    schemaVersion: 1,
    operation: 'worker-credential.inspect',
    request: {
      actionRef: 'worker-credential:worker-1:rotate:1',
      authorityProjectId: 'cluster-authority',
      approvalRequestId: 'approval-worker-1',
      inspectionId: 'inspection-worker-1',
    },
  };
}

function identities() {
  return {
    async reload() {},
    bind(assertion) {
      assert.equal(assertion, 'assertion-value');
      return {
        async authenticate() {
          return {
            subject: { type: 'user', id: 'cluster-reviewer' },
            authenticationId: 'authentication-1',
            authenticatedAtMs: 900,
            expiresAtMs: 10_000,
            assurance: 'multi_factor',
          };
        },
      };
    },
  };
}

async function start(execute, options = {}) {
  return startClusterWorkerCredentialManagementHttp({
    host: '127.0.0.1',
    port: 0,
    tls: {
      privateKey: Buffer.from(readFileSync(SERVER_KEY)),
      certificate: Buffer.from(readFileSync(SERVER_CERT)),
      clientCertificateAuthority: Buffer.from(readFileSync(CLIENT_CA)),
      clientCertificateRevocationList: Buffer.from(
        readFileSync(options.revoked ? REVOKED_CLIENT_CRL : EMPTY_CRL),
      ),
    },
    identities: options.identities ?? identities(),
    transport: { execute },
    limits: { requestTimeoutMs: 2_000, drainTimeoutMs: 500 },
    now: () => 1_000,
    createRequestId: () => 'worker-request-1',
  });
}

async function request(application, path = WORKER_PATH, client = true) {
  const body = Buffer.from(JSON.stringify(command()));
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest(
      {
        host: '127.0.0.1',
        port: application.address.port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        ...(client
          ? {
              cert: readFileSync(CLIENT_CERT),
              key: readFileSync(CLIENT_KEY),
            }
          : {}),
        agent: false,
        headers: {
          authorization: 'Bearer assertion-value',
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('end', () => {
          resolvePromise({
            statusCode: incoming.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

async function health(application, path) {
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest(
      {
        host: '127.0.0.1',
        port: application.address.port,
        path,
        method: 'GET',
        rejectUnauthorized: false,
        agent: false,
      },
      (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolvePromise(incoming.statusCode));
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function startWithClientTrust(
  certificateAuthority,
  certificateRevocationList,
  execute,
) {
  return startClusterWorkerCredentialManagementHttp({
    host: '127.0.0.1',
    port: 0,
    tls: {
      privateKey: Buffer.from(readFileSync(SERVER_KEY)),
      certificate: Buffer.from(readFileSync(SERVER_CERT)),
      clientCertificateAuthority: certificateAuthority,
      clientCertificateRevocationList: certificateRevocationList,
    },
    identities: identities(),
    transport: { execute },
    limits: { requestTimeoutMs: 2_000, drainTimeoutMs: 500 },
    now: () => 1_000,
    createRequestId: () => 'worker-request-rotation',
  });
}

async function requestWithClientIdentity(application, certificate, key) {
  const body = Buffer.from(JSON.stringify(command()));
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest(
      {
        host: '127.0.0.1',
        port: application.address.port,
        path: WORKER_PATH,
        method: 'POST',
        rejectUnauthorized: false,
        cert: readFileSync(certificate),
        key: readFileSync(key),
        agent: false,
        headers: {
          authorization: 'Bearer assertion-value',
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('end', () => {
          resolvePromise({
            statusCode: incoming.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('serves the canonical Worker route and exact credential compatibility alias', async () => {
  const calls = [];
  const application = await start(async (value, authentication) => {
    calls.push({ value, principal: await authentication.authenticate() });
    return {
      schemaVersion: 1,
      operation: 'worker-credential.inspect',
      plan: null,
      approval: null,
      stale: false,
    };
  });
  try {
    const response = await request(application);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.requestId, 'worker-request-1');
    assert.equal(response.body.result.operation, 'worker-credential.inspect');
    assert.deepEqual(calls[0].value, command());
    assert.deepEqual(calls[0].principal.subject, {
      type: 'user',
      id: 'cluster-reviewer',
    });
    const canonical = await request(application, CANONICAL_WORKER_PATH);
    assert.equal(canonical.statusCode, 200);
    assert.equal(canonical.body.result.operation, 'worker-credential.inspect');
    assert.equal(
      (await request(application, '/api/v3/plugin-packages/management'))
        .statusCode,
      404,
    );
    assert.equal(calls.length, 2);
  } finally {
    await application.close();
  }
});

test('requires an authorized client certificate before OIDC or body parsing', async () => {
  let identityBinds = 0;
  let transportCalls = 0;
  const identity = identities();
  const application = await start(
    async () => {
      transportCalls += 1;
    },
    {
      identities: {
        ...identity,
        bind(assertion) {
          identityBinds += 1;
          return identity.bind(assertion);
        },
      },
    },
  );
  try {
    assert.equal(await health(application, '/livez'), 200);
    assert.equal(await health(application, '/readyz'), 200);
    const response = await request(application, WORKER_PATH, false);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, 'client_certificate_required');
    assert.equal(identityBinds, 0);
    assert.equal(transportCalls, 0);
  } finally {
    await application.close();
  }
});

test('rejects a CRL-revoked client certificate before OIDC', async () => {
  let identityBinds = 0;
  const identity = identities();
  const application = await start(async () => assert.fail('must not execute'), {
    revoked: true,
    identities: {
      ...identity,
      bind(assertion) {
        identityBinds += 1;
        return identity.bind(assertion);
      },
    },
  });
  try {
    const response = await request(application);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, 'client_certificate_required');
    assert.equal(identityBinds, 0);
  } finally {
    await application.close();
  }
});

test('maps Worker credential management failures to stable HTTP errors', async () => {
  for (const [failure, statusCode, code] of [
    [
      new WorkerCredentialManagementRequestError('invalid'),
      400,
      'request_invalid',
    ],
    [new WorkerCredentialManagementAuthorizationError(), 403, 'forbidden'],
    [new WorkerCredentialManagementConflictError('conflict'), 409, 'conflict'],
    [
      new WorkerCredentialManagementQuotaExceededError(1_250),
      429,
      'quota_exceeded',
    ],
    [new WorkerCredentialManagementUnavailableError(), 503, 'unavailable'],
  ]) {
    const application = await start(async () => {
      throw failure;
    });
    try {
      const response = await request(application);
      assert.equal(response.statusCode, statusCode);
      assert.equal(response.body.error.code, code);
    } finally {
      await application.close();
    }
  }
});

test('rejects arbitrary management paths at configuration time', async () => {
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
        identities: identities(),
        transport: { async execute() {} },
        managementPath: '/api/v3/arbitrary',
      }),
      ClusterPluginPackageManagementHttpConfigurationError,
    );
  } finally {
    privateKey.fill(0);
  }
});

test('rejects arbitrary or cross-plane compatible route aliases', async () => {
  for (const compatibleManagementPaths of [
    ['/api/v3/automations/management'],
    ['/api/v3/worker-credentials/management', '/api/v3/runs/management'],
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
          identities: identities(),
          transport: { async execute() {} },
          managementPath: CANONICAL_WORKER_PATH,
          compatibleManagementPaths,
        }),
        ClusterPluginPackageManagementHttpConfigurationError,
      );
    } finally {
      privateKey.fill(0);
    }
  }
});

test('accepts both client CAs during overlap then rejects the retired CA', async () => {
  const execute = async () => ({
    schemaVersion: 1,
    operation: 'worker-credential.inspect',
    plan: null,
    approval: null,
    stale: false,
  });
  const oldAuthority = Buffer.from(readFileSync(CLIENT_CA));
  const nextAuthority = Buffer.from(readFileSync(NEXT_CLIENT_CA));
  const oldRevocationList = Buffer.from(readFileSync(EMPTY_CRL));
  const nextRevocationList = Buffer.from(readFileSync(NEXT_CLIENT_CRL));
  const overlap = await startWithClientTrust(
    Buffer.concat([oldAuthority, nextAuthority]),
    Buffer.concat([oldRevocationList, nextRevocationList]),
    execute,
  );
  try {
    assert.equal((await request(overlap)).statusCode, 200);
    assert.equal(
      (
        await requestWithClientIdentity(
          overlap,
          NEXT_CLIENT_CERT,
          NEXT_CLIENT_KEY,
        )
      ).statusCode,
      200,
    );
  } finally {
    await overlap.close();
  }

  const retired = await startWithClientTrust(
    nextAuthority,
    nextRevocationList,
    execute,
  );
  try {
    assert.equal((await request(retired)).statusCode, 401);
    assert.equal(
      (
        await requestWithClientIdentity(
          retired,
          NEXT_CLIENT_CERT,
          NEXT_CLIENT_KEY,
        )
      ).statusCode,
      200,
    );
  } finally {
    await retired.close();
  }
});
