'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  createRemoteWorkerArtifactUploadResponseBody,
  createRemoteWorkerCompletionResponseBody,
  parseRemoteWorkerArtifactUploadHeader,
} = require('@qinglong/runtime-core/remote-worker-completion');
const {
  WorkerRemoteArtifactHttpsUploader,
  WorkerRemoteCompletionHttpsError,
  WorkerRemoteExecutionHttpsCompletionClient,
} = require('@qinglong/worker-runtime/completion-transport');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LOG_ARTIFACT_ID = `wlog-${'a'.repeat(30)}`;
const CALLBACK_DIGEST = 'b'.repeat(64);

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

function uploadCommand(content) {
  return {
    ...fence(),
    logArtifactId: LOG_ARTIFACT_ID,
    byteLength: content.byteLength,
    truncated: false,
    content: (async function* () { yield content; })(),
  };
}

function completionCommand(content, overrides = {}) {
  return {
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
      sha256: createHash('sha256').update(content).digest('hex'),
      truncated: false,
    },
    executorType: 'remote_worker',
    ...overrides,
  };
}

test('uploads one framed Artifact and verifies exact response authority', async () => {
  const content = Buffer.from('worker-log');
  let observed;
  const uploader = new WorkerRemoteArtifactHttpsUploader({
    client: {
      async postStream(request) {
        const chunks = [];
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        const envelope = Buffer.concat(chunks);
        const headerLength = envelope.readUInt32BE(0);
        const header = parseRemoteWorkerArtifactUploadHeader(
          envelope.subarray(4, 4 + headerLength),
          { workerId: 'worker-1', workerSessionId: SESSION_ID },
        );
        observed = { request, envelope, header, headerLength };
        return Buffer.from(JSON.stringify(
          createRemoteWorkerArtifactUploadResponseBody({
            status: 'stored',
            projectId: 'project-1',
            runId: 'run-1',
            attemptId: 'attempt-1',
            logArtifactId: LOG_ARTIFACT_ID,
            byteLength: content.byteLength,
            sha256: createHash('sha256').update(content).digest('hex'),
            truncated: false,
          }),
        ));
      },
    },
  });
  const result = await uploader.upload(uploadCommand(content));
  assert.equal(result.status, 'stored');
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(
    observed.request.path,
    `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/artifacts`,
  );
  assert.equal(observed.request.byteLength, observed.envelope.byteLength);
  assert.deepEqual(
    observed.envelope.subarray(4 + observed.headerLength),
    content,
  );
  assert.equal(observed.header.leaseToken, LEASE_TOKEN);
  assert.equal(observed.header.logArtifactId, LOG_ARTIFACT_ID);
});

test('rejects Artifact receipt authority drift', async () => {
  const content = Buffer.from('log');
  const uploader = new WorkerRemoteArtifactHttpsUploader({
    client: {
      async postStream(request) {
        for await (const _chunk of request.body) { /* consume */ }
        return Buffer.from(JSON.stringify(
          createRemoteWorkerArtifactUploadResponseBody({
            status: 'stored',
            projectId: 'project-other',
            runId: 'run-1',
            attemptId: 'attempt-1',
            logArtifactId: LOG_ARTIFACT_ID,
            byteLength: content.byteLength,
            sha256: 'c'.repeat(64),
            truncated: false,
          }),
        ));
      },
    },
  });
  await assert.rejects(
    uploader.upload(uploadCommand(content)),
    (error) =>
      error instanceof WorkerRemoteCompletionHttpsError &&
      error.reason === 'response_invalid',
  );
});

test('posts exact completion JSON and binds the response to the receipt', async () => {
  const content = Buffer.from('worker-log');
  let observed;
  const client = new WorkerRemoteExecutionHttpsCompletionClient({
    client: {
      async postJson(request) {
        observed = request;
        return Buffer.from(JSON.stringify(
          createRemoteWorkerCompletionResponseBody({
            status: 'applied',
            runId: 'run-1',
            attemptId: 'attempt-1',
            callbackSequence: 1,
          }),
        ));
      },
    },
  });
  assert.deepEqual(await client.complete(completionCommand(content)), {
    status: 'applied',
    runId: 'run-1',
    attemptId: 'attempt-1',
    callbackSequence: 1,
  });
  assert.equal(
    observed.path,
    `/api/v3/worker-ingress/workers/worker-1/sessions/${SESSION_ID}/completion`,
  );
  assert.equal(observed.body.schema, 'qinglong/remote-worker-completion@v1');
  assert.equal('workerId' in observed.body, false);
  assert.equal('workerSessionId' in observed.body, false);
  assert.equal(observed.body.callbackTokenDigest, CALLBACK_DIGEST);
  assert.equal(observed.body.leaseToken, LEASE_TOKEN);
});

test('rejects non-Worker execution and response authority drift', async () => {
  const content = Buffer.from('log');
  let calls = 0;
  const client = new WorkerRemoteExecutionHttpsCompletionClient({
    client: {
      async postJson() {
        calls += 1;
        return Buffer.from(JSON.stringify(
          createRemoteWorkerCompletionResponseBody({
            status: 'applied',
            runId: 'run-other',
            attemptId: 'attempt-1',
            callbackSequence: 1,
          }),
        ));
      },
    },
  });
  await assert.rejects(
    client.complete(completionCommand(content, { executorType: 'local_process' })),
    (error) =>
      error instanceof WorkerRemoteCompletionHttpsError &&
      error.reason === 'request_invalid',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    client.complete(completionCommand(content)),
    (error) =>
      error instanceof WorkerRemoteCompletionHttpsError &&
      error.reason === 'response_invalid',
  );
  assert.equal(calls, 1);
});
