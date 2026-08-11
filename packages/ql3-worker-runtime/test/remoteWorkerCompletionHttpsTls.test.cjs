'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { test } = require('node:test');
const {
  REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
  createRemoteWorkerArtifactUploadResponseBody,
  createRemoteWorkerCompletionResponseBody,
  parseRemoteWorkerArtifactUploadHeader,
  parseRemoteWorkerCompletionRequestBody,
} = require('@qinglong/runtime-core/remote-worker-completion');
const {
  createRemoteWorkerLeaseControlResponseBody,
  parseRemoteWorkerLeaseControlRequestBody,
} = require('@qinglong/runtime-core/remote-worker-lease-control');
const {
  WorkerIngressHttpsClient,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');
const {
  WorkerRemoteArtifactHttpsUploader,
  WorkerRemoteExecutionHttpsCompletionClient,
} = require('../dist/remote-execution/transport/remoteWorkerCompletionHttpsClient');
const {
  WorkerRemoteLeaseControlHttpsClient,
} = require('../dist/remote-execution/transport/remoteWorkerLeaseControlHttpsClient');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const AUTHORIZATION =
  `Worker ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}`;
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LOG_ARTIFACT_ID = `wlog-${'a'.repeat(30)}`;
const CALLBACK_DIGEST = 'b'.repeat(64);
const fixtures = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);

async function material(name) {
  return readFile(path.join(fixtures, name));
}

function fence() {
  return {
    workerId: 'worker-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: LEASE_TOKEN,
    expectedLeaseVersion: 4,
  };
}

function json(response, body) {
  const serialized = Buffer.from(JSON.stringify(body));
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(serialized.byteLength),
  });
  response.end(serialized);
}

test('streams Artifact, completion and lease control over one TLS 1.3 mTLS client', async () => {
  const [ca, serverCertificate, serverKey, clientCertificate, clientKey] =
    await Promise.all([
      material('ca-cert.pem'),
      material('server-cert.pem'),
      material('server-key.pem'),
      material('client-cert.pem'),
      material('client-key.pem'),
    ]);
  const content = Buffer.from('first log frame\nsecond log frame\n');
  const digest = createHash('sha256').update(content).digest('hex');
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
      const body = Buffer.concat(chunks);
      const common = {
        authorized: request.socket.authorized,
        protocol: request.socket.getProtocol(),
        authorization: request.headers.authorization,
        contentLength: request.headers['content-length'],
        contentType: request.headers['content-type'],
        path: request.url,
      };
      if (request.url.endsWith('/artifacts')) {
        const headerLength = body.readUInt32BE(0);
        const header = parseRemoteWorkerArtifactUploadHeader(
          body.subarray(4, 4 + headerLength),
          { workerId: 'worker-1', workerSessionId: SESSION_ID },
        );
        const artifact = body.subarray(4 + headerLength);
        observations.push({ ...common, header, artifact: artifact.toString() });
        json(response, createRemoteWorkerArtifactUploadResponseBody({
          status: 'stored',
          projectId: header.projectId,
          runId: header.runId,
          attemptId: header.attemptId,
          logArtifactId: header.logArtifactId,
          byteLength: artifact.byteLength,
          sha256: createHash('sha256').update(artifact).digest('hex'),
          truncated: header.truncated,
        }));
        return;
      }
      if (request.url.endsWith('/lease-control')) {
        const control = parseRemoteWorkerLeaseControlRequestBody(
          JSON.parse(body.toString('utf8')),
          { workerId: 'worker-1', workerSessionId: SESSION_ID },
        );
        observations.push({ ...common, control });
        json(response, createRemoteWorkerLeaseControlResponseBody({
          status: 'renewed',
          projectId: control.projectId,
          runId: control.runId,
          attemptId: control.attemptId,
          offerId: control.offerId,
          leaseGeneration: control.leaseGeneration,
          leaseVersion: control.expectedLeaseVersion + 1,
          renewedAtMs: 1_000,
          expiresAtMs: 31_000,
        }));
        return;
      }
      const completion = parseRemoteWorkerCompletionRequestBody(
        JSON.parse(body.toString('utf8')),
        { workerId: 'worker-1', workerSessionId: SESSION_ID },
      );
      observations.push({ ...common, completion });
      json(response, createRemoteWorkerCompletionResponseBody({
        status: 'applied',
        runId: completion.runId,
        attemptId: completion.attemptId,
        callbackSequence: completion.callbackSequence,
      }));
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
    const uploader = new WorkerRemoteArtifactHttpsUploader({ client: shared });
    const completion = new WorkerRemoteExecutionHttpsCompletionClient({
      client: shared,
    });
    const leaseControl = new WorkerRemoteLeaseControlHttpsClient({
      client: shared,
    });
    const artifact = await uploader.upload({
      ...fence(),
      logArtifactId: LOG_ARTIFACT_ID,
      byteLength: content.byteLength,
      truncated: false,
      content: (async function* () {
        yield content.subarray(0, 7);
        yield content.subarray(7);
      })(),
    });
    assert.deepEqual(artifact, {
      status: 'stored',
      logArtifactId: LOG_ARTIFACT_ID,
      byteLength: content.byteLength,
      sha256: digest,
    });
    assert.deepEqual(await completion.complete({
      ...fence(),
      callbackSequence: 1,
      callbackTokenDigest: CALLBACK_DIGEST,
      result: {
        outcome: 'succeeded',
        startedAtMs: 100,
        finishedAtMs: 200,
        exitCode: 0,
      },
      artifact: {
        logArtifactId: LOG_ARTIFACT_ID,
        byteLength: content.byteLength,
        sha256: digest,
        truncated: false,
      },
      executorType: 'remote_worker',
    }), {
      status: 'applied',
      runId: 'run-1',
      attemptId: 'attempt-1',
      callbackSequence: 1,
    });
    assert.deepEqual(await leaseControl.control(fence()), {
      status: 'renewed',
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      offerId: 'offer-1',
      leaseGeneration: 3,
      leaseVersion: 5,
      renewedAtMs: 1_000,
      expiresAtMs: 31_000,
    });
    assert.equal(observations.length, 3);
    assert.deepEqual(observations.map((value) => ({
      authorized: value.authorized,
      protocol: value.protocol,
      authorization: value.authorization,
    })), [
      { authorized: true, protocol: 'TLSv1.3', authorization: AUTHORIZATION },
      { authorized: true, protocol: 'TLSv1.3', authorization: AUTHORIZATION },
      { authorized: true, protocol: 'TLSv1.3', authorization: AUTHORIZATION },
    ]);
    assert.equal(
      observations[0].path,
      `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/artifacts`,
    );
    assert.equal(
      observations[0].contentType,
      REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
    );
    assert.equal(observations[0].artifact, content.toString());
    assert.equal(observations[0].header.leaseToken, LEASE_TOKEN);
    assert.equal(
      observations[1].path,
      `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/completion`,
    );
    assert.equal(observations[1].contentType, 'application/json');
    assert.equal(observations[1].completion.callbackTokenDigest, CALLBACK_DIGEST);
    assert.equal(observations[1].completion.artifact.sha256, digest);
    assert.equal(
      observations[2].path,
      `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/lease-control`,
    );
    assert.equal(observations[2].control.leaseToken, LEASE_TOKEN);
  } finally {
    shared.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
