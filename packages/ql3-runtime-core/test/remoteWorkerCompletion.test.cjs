'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_REMOTE_WORKER_ARTIFACT_BYTES,
  MAX_REMOTE_WORKER_ARTIFACT_RESPONSE_BYTES,
  MAX_REMOTE_WORKER_COMPLETION_RESPONSE_BYTES,
  REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA,
  REMOTE_WORKER_COMPLETION_SCHEMA,
  createRemoteWorkerArtifactUploadPreamble,
  createRemoteWorkerArtifactUploadRequestHeader,
  createRemoteWorkerArtifactUploadResponseBody,
  createRemoteWorkerCompletionRequestBody,
  createRemoteWorkerCompletionResponseBody,
  normalizeRemoteWorkerArtifactUploadCommand,
  normalizeRemoteWorkerCompletionCommand,
  parseRemoteWorkerArtifactUploadHeader,
  parseRemoteWorkerArtifactUploadResponse,
  parseRemoteWorkerCompletionRequestBody,
  parseRemoteWorkerCompletionResponse,
} = require('../dist/remote-execution/remoteWorkerCompletion');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LOG_ARTIFACT_ID = `wlog-${'a'.repeat(30)}`;
const SHA256 = 'b'.repeat(64);
const CALLBACK_TOKEN_DIGEST = 'c'.repeat(64);

function fence(overrides = {}) {
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
    ...overrides,
  };
}

function uploadCommand(overrides = {}) {
  return {
    ...fence(),
    logArtifactId: LOG_ARTIFACT_ID,
    byteLength: 17,
    truncated: false,
    ...overrides,
  };
}

function completionCommand(overrides = {}) {
  return {
    ...fence(),
    callbackSequence: 1,
    callbackTokenDigest: CALLBACK_TOKEN_DIGEST,
    result: {
      outcome: 'succeeded',
      startedAtMs: 100,
      finishedAtMs: 200,
      exitCode: 0,
    },
    artifact: {
      logArtifactId: LOG_ARTIFACT_ID,
      byteLength: 17,
      sha256: SHA256,
      truncated: false,
    },
    ...overrides,
  };
}

test('frames one exact Artifact header without duplicating path identity', () => {
  const command = uploadCommand();
  const header = createRemoteWorkerArtifactUploadRequestHeader(command);
  assert.equal(header.schema, REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA);
  assert.equal('workerId' in header, false);
  assert.equal('workerSessionId' in header, false);
  assert.equal(header.truncated, false);

  const preamble = createRemoteWorkerArtifactUploadPreamble(command);
  const headerLength = preamble.readUInt32BE(0);
  assert.equal(headerLength, preamble.byteLength - 4);
  assert.deepEqual(
    parseRemoteWorkerArtifactUploadHeader(
      preamble.subarray(4),
      { workerId: command.workerId, workerSessionId: command.workerSessionId },
    ),
    normalizeRemoteWorkerArtifactUploadCommand(command),
  );
});

test('round-trips immutable Artifact receipts and nullable truncation', () => {
  const receipt = {
    status: 'stored',
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    logArtifactId: LOG_ARTIFACT_ID,
    byteLength: 17,
    sha256: SHA256,
  };
  const body = createRemoteWorkerArtifactUploadResponseBody(receipt);
  assert.equal(body.truncated, null);
  assert.deepEqual(
    parseRemoteWorkerArtifactUploadResponse(JSON.stringify(body)),
    receipt,
  );

  const truncated = createRemoteWorkerArtifactUploadResponseBody({
    ...receipt,
    status: 'already_stored',
    truncated: false,
  });
  assert.equal(
    parseRemoteWorkerArtifactUploadResponse(JSON.stringify(truncated)).truncated,
    false,
  );
});

test('round-trips an exact path-bound completion request and response', () => {
  const command = completionCommand();
  const request = createRemoteWorkerCompletionRequestBody(command);
  assert.equal(request.schema, REMOTE_WORKER_COMPLETION_SCHEMA);
  assert.equal('workerId' in request, false);
  assert.equal('workerSessionId' in request, false);
  assert.deepEqual(
    parseRemoteWorkerCompletionRequestBody(request, {
      workerId: command.workerId,
      workerSessionId: command.workerSessionId,
    }),
    normalizeRemoteWorkerCompletionCommand(command),
  );

  const result = {
    status: 'applied',
    runId: 'run-1',
    attemptId: 'attempt-1',
    callbackSequence: 1,
  };
  const response = createRemoteWorkerCompletionResponseBody(result);
  assert.deepEqual(
    parseRemoteWorkerCompletionResponse(JSON.stringify(response)),
    result,
  );
  assert.equal(Object.isFrozen(response), true);
});

test('rejects widened wire shapes and invalid path authority', () => {
  const header = createRemoteWorkerArtifactUploadRequestHeader(uploadCommand());
  assert.throws(
    () => parseRemoteWorkerArtifactUploadHeader(JSON.stringify({
      ...header,
      workerId: 'body-must-not-own-transport-identity',
    }), { workerId: 'worker-1', workerSessionId: SESSION_ID }),
    /header shape is invalid/,
  );

  const request = createRemoteWorkerCompletionRequestBody(completionCommand());
  assert.throws(
    () => parseRemoteWorkerCompletionRequestBody({
      ...request,
      callbackToken: 'plaintext-is-forbidden',
    }, { workerId: 'worker-1', workerSessionId: SESSION_ID }),
    /request shape is invalid/,
  );
  assert.throws(
    () => parseRemoteWorkerCompletionRequestBody(request, {
      workerId: 'invalid worker id',
      workerSessionId: SESSION_ID,
    }),
    /execution authority is invalid/,
  );
});

test('rejects inconsistent completion evidence and oversized Artifacts', () => {
  assert.throws(
    () => normalizeRemoteWorkerCompletionCommand(completionCommand({
      result: {
        outcome: 'succeeded',
        startedAtMs: 100,
        finishedAtMs: 200,
        exitCode: 1,
      },
    })),
    /result is inconsistent/,
  );
  assert.throws(
    () => normalizeRemoteWorkerCompletionCommand(completionCommand({
      callbackTokenDigest: 'not-a-digest',
    })),
    /completion evidence is invalid/,
  );
  assert.throws(
    () => normalizeRemoteWorkerArtifactUploadCommand(uploadCommand({
      byteLength: MAX_REMOTE_WORKER_ARTIFACT_BYTES + 1,
    })),
    /byteLength is invalid/,
  );
  assert.throws(
    () => normalizeRemoteWorkerCompletionCommand(completionCommand({
      artifact: {
        logArtifactId: LOG_ARTIFACT_ID,
        byteLength: 17,
        sha256: 'not-a-digest',
      },
    })),
    /completion evidence is invalid/,
  );
});

test('bounds Artifact and completion response envelopes', () => {
  assert.throws(
    () => parseRemoteWorkerArtifactUploadResponse(
      Buffer.alloc(MAX_REMOTE_WORKER_ARTIFACT_RESPONSE_BYTES + 1),
    ),
    /response byte size is invalid/,
  );
  assert.throws(
    () => parseRemoteWorkerCompletionResponse(
      Buffer.alloc(MAX_REMOTE_WORKER_COMPLETION_RESPONSE_BYTES + 1),
    ),
    /response byte size is invalid/,
  );
});
