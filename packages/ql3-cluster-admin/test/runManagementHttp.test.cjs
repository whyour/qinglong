'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { request: httpsRequest } = require('node:https');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterRunManagementRateLimitedError,
} = require('@qinglong/cluster-admin/run-management');
const {
  startClusterRunManagementHttp,
} = require('@qinglong/cluster-admin/run-management-http');

const SERVER_KEY = resolve(__dirname, '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem');
const SERVER_CERT = resolve(__dirname, '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem');
const PATH = '/api/v3/runs/management';

function post(port, path = PATH) {
  const body = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    operation: 'run.retry',
    request: {
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      requestId: 'request-1',
      auditEventId: '019f9600-0000-4000-8000-000000000001',
      failureAuditEventId: '019f9600-0000-4000-8000-000000000002',
      body: {
        schema: 'qinglong/run-manual-retry@v1',
        mutationId: '019f9600-0000-4000-8000-000000000003',
        expectedRunVersion: 7,
        expectedRunStatus: 'failed',
      },
    },
  }));
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpsRequest({
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
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.once('end', () => {
        const bytes = Buffer.concat(chunks);
        resolvePromise({
          statusCode: incoming.statusCode,
          headers: incoming.headers,
          body: bytes.length ? JSON.parse(bytes.toString('utf8')) : null,
        });
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('serves only the Run path and maps durable quota to bounded HTTP facts', async () => {
  const application = await startClusterRunManagementHttp({
    host: '127.0.0.1',
    port: 0,
    tls: {
      privateKey: Buffer.from(readFileSync(SERVER_KEY)),
      certificate: Buffer.from(readFileSync(SERVER_CERT)),
    },
    identities: {
      async reload() { throw new Error('not used'); },
      bind() {
        return { authenticate: async () => ({
          subject: { type: 'user', id: 'operator-1' },
          authenticationId: 'oidc:run-management-1',
          authenticatedAtMs: 900,
          expiresAtMs: 10_000,
          assurance: 'hardware',
        }) };
      },
    },
    transport: {
      async execute(_command, authentication) {
        await authentication.authenticate();
        throw new ClusterRunManagementRateLimitedError(1_500);
      },
    },
    now: () => 1_000,
  });
  try {
    const limited = await post(application.address.port);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '2');
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.match(limited.body.requestId, /^[0-9a-f-]{36}$/);
    const absent = await post(application.address.port, '/api/v3/approvals/management');
    assert.equal(absent.statusCode, 404);
    assert.equal(absent.body.error.code, 'not_found');
  } finally {
    await application.close();
  }
});
