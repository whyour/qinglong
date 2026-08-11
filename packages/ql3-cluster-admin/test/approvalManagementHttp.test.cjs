const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { request: httpsRequest } = require('node:https');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  startClusterApprovalManagementHttp,
} = require('@qinglong/cluster-admin/approval-management-http');
const {
  ClusterApprovalManagementTransportConflictError,
} = require('@qinglong/cluster-admin/approval-management-transport');

const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);
const PATH = '/api/v3/approvals/management';

function post(port, path = PATH) {
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      operation: 'approval.inspect',
      request: {
        projectId: 'default',
        approvalRequestId: 'approval-1',
        requestId: 'approval-command-1',
        auditEventId: '50000000-0000-4000-8000-000000000001',
        failureAuditEventId: '50000000-0000-4000-8000-000000000002',
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

test('serves only the human Approval path and maps conflicts to low-sensitive facts', async () => {
  const privateKey = Buffer.from(readFileSync(SERVER_KEY));
  const application = await startClusterApprovalManagementHttp({
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
          audience: 'qinglong3-approval-management',
          activeKeyIds: ['key-1'],
          revokedKeyIds: [],
        };
      },
      bind() {
        return {
          async authenticate() {
            return {
              subject: { type: 'user', id: 'owner-1' },
              authenticationId: 'session-owner-1',
              authenticatedAtMs: 900,
              expiresAtMs: 10_000,
              assurance: 'hardware',
            };
          },
        };
      },
    },
    transport: {
      async execute(_command, authentication) {
        await authentication.authenticate();
        throw new ClusterApprovalManagementTransportConflictError();
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
      '/api/v3/automations/management',
    );
    assert.equal(absent.statusCode, 404);
    assert.equal(absent.body.error.code, 'not_found');
  } finally {
    await application.close();
  }
});
