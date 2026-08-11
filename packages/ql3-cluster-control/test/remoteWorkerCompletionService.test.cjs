'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  RemoteWorkerCompletionFenceRejectedError,
  RemoteWorkerCompletionUnavailableError,
  createRemoteWorkerArtifactUploadPreamble,
} = require('@qinglong/runtime-core/remote-worker-completion');
const {
  ClusterRemoteWorkerArtifactService,
  ClusterRemoteWorkerCompletionService,
} = require('@qinglong/cluster-control/remote-completion');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LOG_ARTIFACT_ID = `wlog-${'a'.repeat(30)}`;
const CALLBACK_TOKEN_DIGEST = 'b'.repeat(64);

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

function uploadCommand(content, overrides = {}) {
  return {
    ...fence(),
    logArtifactId: LOG_ARTIFACT_ID,
    byteLength: content.byteLength,
    truncated: false,
    ...overrides,
  };
}

function completionCommand(content, overrides = {}) {
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
      byteLength: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      truncated: false,
    },
    ...overrides,
  };
}

function split(bytes, sizes) {
  return (async function* () {
    let offset = 0;
    for (const size of sizes) {
      yield bytes.subarray(offset, offset + size);
      offset += size;
    }
    if (offset < bytes.byteLength) yield bytes.subarray(offset);
  })();
}

test('authorizes a framed upload before storing exact capability-free bytes', async () => {
  const content = Buffer.from('worker-log');
  const command = uploadCommand(content);
  const preamble = createRemoteWorkerArtifactUploadPreamble(command);
  const envelope = Buffer.concat([preamble, content]);
  const observations = [];
  const service = new ClusterRemoteWorkerArtifactService(
    {
      async authorizeArtifactUpload(value) {
        observations.push({ kind: 'authority', value });
      },
    },
    {
      async put(target, chunks) {
        const stored = [];
        for await (const chunk of chunks) stored.push(Buffer.from(chunk));
        const bytes = Buffer.concat(stored);
        observations.push({ kind: 'store', target, bytes });
        return {
          status: 'stored',
          ...target,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      },
      async inspect() { return undefined; },
    },
  );

  const receipt = await service.upload({
    workerId: command.workerId,
    workerSessionId: command.workerSessionId,
    contentLength: envelope.byteLength,
    chunks: split(envelope, [1, 2, 1, 3, 5]),
  });
  assert.equal(receipt.sha256, createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(observations.map(({ kind }) => kind), ['authority', 'store']);
  assert.deepEqual(observations[0].value, command);
  assert.equal('leaseToken' in observations[1].target, false);
  assert.equal('workerId' in observations[1].target, false);
  assert.deepEqual(observations[1].bytes, content);
});

test('rejects envelope drift before authority or storage access', async () => {
  const content = Buffer.from('log');
  const command = uploadCommand(content);
  const preamble = createRemoteWorkerArtifactUploadPreamble(command);
  const envelope = Buffer.concat([preamble, content]);
  let authorityCalls = 0;
  let storeCalls = 0;
  const service = new ClusterRemoteWorkerArtifactService(
    {
      async authorizeArtifactUpload() { authorityCalls += 1; },
    },
    {
      async put() { storeCalls += 1; throw new Error('must not store'); },
      async inspect() { return undefined; },
    },
  );
  await assert.rejects(
    service.upload({
      workerId: command.workerId,
      workerSessionId: command.workerSessionId,
      contentLength: envelope.byteLength + 1,
      chunks: split(envelope, [4]),
    }),
    /envelope length does not match/,
  );
  assert.equal(authorityCalls, 0);
  assert.equal(storeCalls, 0);
});

test('fails closed when a store does not consume or drifts from the command', async () => {
  const content = Buffer.from('log');
  const command = uploadCommand(content);
  const preamble = createRemoteWorkerArtifactUploadPreamble(command);
  const envelope = Buffer.concat([preamble, content]);
  const service = new ClusterRemoteWorkerArtifactService(
    { async authorizeArtifactUpload() {} },
    {
      async put(target) {
        return { status: 'stored', ...target, sha256: 'c'.repeat(64) };
      },
      async inspect() { return undefined; },
    },
  );
  await assert.rejects(
    service.upload({
      workerId: command.workerId,
      workerSessionId: command.workerSessionId,
      contentLength: envelope.byteLength,
      chunks: split(envelope, [4]),
    }),
    RemoteWorkerCompletionUnavailableError,
  );
});

test('inspects immutable Artifact evidence before one server-ID completion', async () => {
  const content = Buffer.from('worker-log');
  const command = completionCommand(content);
  const calls = [];
  const ids = [
    '018f0000-0000-7000-8000-000000000011',
    '018f0000-0000-7000-8000-000000000012',
  ];
  const service = new ClusterRemoteWorkerCompletionService(
    {
      async complete(value) {
        calls.push({ kind: 'repository', value });
        return {
          status: 'applied',
          runId: value.runId,
          attemptId: value.attemptId,
          callbackSequence: value.callbackSequence,
        };
      },
    },
    {
      async inspect(lookup) {
        calls.push({ kind: 'store', lookup });
        return {
          status: 'already_stored',
          ...lookup,
          byteLength: content.byteLength,
          sha256: command.artifact.sha256,
          truncated: false,
        };
      },
    },
    { createEventId: () => ids.shift() },
  );
  assert.deepEqual(await service.complete(command), {
    status: 'applied',
    runId: 'run-1',
    attemptId: 'attempt-1',
    callbackSequence: 1,
  });
  assert.deepEqual(calls.map(({ kind }) => kind), ['store', 'repository']);
  assert.equal(calls[1].value.attemptEventId.endsWith('11'), true);
  assert.equal(calls[1].value.runEventId.endsWith('12'), true);
});

test('fences missing or digest-drifted Artifact evidence before completion', async () => {
  const content = Buffer.from('worker-log');
  const command = completionCommand(content);
  let repositoryCalls = 0;
  const repository = {
    async complete() { repositoryCalls += 1; throw new Error('must not run'); },
  };
  const missing = new ClusterRemoteWorkerCompletionService(
    repository,
    { async inspect() { return undefined; } },
  );
  await assert.rejects(
    missing.complete(command),
    (error) =>
      error instanceof RemoteWorkerCompletionFenceRejectedError &&
      error.reason === 'state_mismatch',
  );

  const drifted = new ClusterRemoteWorkerCompletionService(
    repository,
    {
      async inspect(lookup) {
        return {
          status: 'stored',
          ...lookup,
          byteLength: content.byteLength,
          sha256: 'd'.repeat(64),
          truncated: false,
        };
      },
    },
  );
  await assert.rejects(
    drifted.complete(command),
    (error) =>
      error instanceof RemoteWorkerCompletionFenceRejectedError &&
      error.reason === 'replay_mismatch',
  );
  assert.equal(repositoryCalls, 0);
});
