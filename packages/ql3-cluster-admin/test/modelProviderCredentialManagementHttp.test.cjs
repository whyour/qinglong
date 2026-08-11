const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { request: httpsRequest } = require('node:https');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterModelProviderCredentialManagementConflictError,
} = require('@qinglong/cluster-admin/model-provider-credential-management');
const {
  startClusterModelProviderCredentialManagementHttp,
} = require('@qinglong/cluster-admin/model-provider-credential-management-http');

const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);
const PATH = '/api/v3/provider-credentials/management';

function post(port, path = PATH) {
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      operation: 'provider-credential.revoke',
      request: {
        requestId: 'request-provider-revoke',
        mutationId: '1e828c8a-86d7-4b24-bbe0-2d9ecf1c1eab',
        projectId: 'project-a',
        provider: 'openai-compatible',
        expectedGeneration: 1,
      },
    }),
  );
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        agent: false,
        headers: {
          authorization: 'Bearer assertion',
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('end', () => {
          const bytes = Buffer.concat(chunks);
          resolvePromise({
            statusCode: incoming.statusCode,
            body: bytes.length ? JSON.parse(bytes.toString('utf8')) : null,
          });
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('serves only the provider credential path and maps conflicts to low-sensitive HTTP facts', async () => {
  const privateKey = Buffer.from(readFileSync(SERVER_KEY));
  const application = await startClusterModelProviderCredentialManagementHttp({
    host: '127.0.0.1',
    port: 0,
    tls: {
      privateKey,
      certificate: Buffer.from(readFileSync(SERVER_CERT)),
    },
    identities: {
      async reload() {
        return {
          schemaVersion: 1,
          generation: 1,
          digest: 'digest',
          issuer: 'https://identity.example.test/',
          audience: 'qinglong3-model-provider-credential-management',
          activeKeyIds: ['provider-key-1'],
          revokedKeyIds: [],
        };
      },
      bind() {
        return {
          async authenticate() {
            return {
              subject: { type: 'user', id: 'operator-a' },
              authenticationId: 'session-operator-a',
              authenticatedAtMs: 900,
              expiresAtMs: 10_000,
              assurance: 'multi_factor',
            };
          },
        };
      },
    },
    transport: {
      async execute(_command, authentication) {
        await authentication.authenticate();
        throw new ClusterModelProviderCredentialManagementConflictError();
      },
    },
    now: () => 1_000,
  });
  try {
    assert.equal(privateKey.every((value) => value === 0), true);
    const conflict = await post(application.address.port);
    assert.deepEqual(conflict, {
      statusCode: 409,
      body: {
        schemaVersion: 1,
        requestId: conflict.body.requestId,
        error: { code: 'conflict' },
      },
    });
    assert.match(conflict.body.requestId, /^[0-9a-f-]{36}$/);
    const absent = await post(
      application.address.port,
      '/api/v3/plugin-packages/management',
    );
    assert.equal(absent.statusCode, 404);
    assert.equal(absent.body.error.code, 'not_found');
  } finally {
    await application.close();
  }
});
