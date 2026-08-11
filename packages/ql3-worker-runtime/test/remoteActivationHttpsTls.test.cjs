'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerIngressHttpsClient,
  WorkerRemoteExecutionHttpsActivationClient,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const AUTHORIZATION =
  `Worker ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}`;
const fixtures = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);

async function material(name) {
  return readFile(path.join(fixtures, name));
}

test('completes a real TLS 1.3 mutual-auth activation exchange', async () => {
  const [ca, serverCertificate, serverKey, clientCertificate, clientKey] =
    await Promise.all([
      material('ca-cert.pem'),
      material('server-cert.pem'),
      material('server-key.pem'),
      material('client-cert.pem'),
      material('client-key.pem'),
    ]);
  const observations = [];
  const server = https.createServer({
    ca,
    cert: serverCertificate,
    key: serverKey,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      observations.push({
        authorized: request.socket.authorized,
        protocol: request.socket.getProtocol(),
        authorization: request.headers.authorization,
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      const body = JSON.stringify({
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
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const shared = new WorkerIngressHttpsClient({
    origin: `https://127.0.0.1:${address.port}`,
    credentials: {
      async load() {
        return {
          authorization: AUTHORIZATION,
          certificateChainPem: clientCertificate,
          privateKeyPem: clientKey,
          trustAnchors: [ca],
        };
      },
    },
  });
  try {
    const activation = new WorkerRemoteExecutionHttpsActivationClient({
      client: shared,
    });
    const result = await activation.acknowledgeStarting({
      runId: 'run-1',
      attemptId: 'attempt-1',
      workerId: 'edge-1',
      workerSessionId: SESSION_ID,
      workerGeneration: 2,
      offerId: 'offer-1',
      leaseGeneration: 3,
      leaseToken: 'worker_generated_lease_capability_0000000000000001',
      expectedLeaseVersion: 4,
      eventId: '018f0000-0000-7000-8000-000000000002',
    });
    assert.equal(result.status, 'applied');
    assert.deepEqual(observations, [{
      authorized: true,
      protocol: 'TLSv1.3',
      authorization: AUTHORIZATION,
      path: `/api/v3/worker-ingress/workers/edge-1/sessions/${SESSION_ID}/starting`,
      body: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        workerGeneration: 2,
        offerId: 'offer-1',
        leaseGeneration: 3,
        leaseToken: 'worker_generated_lease_capability_0000000000000001',
        expectedLeaseVersion: 4,
      },
    }]);
  } finally {
    shared.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
