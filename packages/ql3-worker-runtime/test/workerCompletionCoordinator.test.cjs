'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  createClusterRemoteExecutionOffer,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core/run-dispatch-lease');
const {
  assertWorkerRemoteExecutionInboxTransition,
  createWorkerRemoteExecutionInboxRecord,
} = require('../dist/remote-execution/executionInbox');
const {
  WorkerRemoteCompletionCoordinator,
} = require('../dist/execution/workerCompletionCoordinator');

const RUN_ID = '019f70e0-0000-7000-8000-000000000201';
const ATTEMPT_ID = '019f70e0-0000-7000-8000-000000000202';
const SESSION_ID = '019f70e0-0000-7000-8000-000000000203';
const TOKEN = Buffer.alloc(32, 0x41);
const TOKEN_DIGEST = createHash('sha256').update(TOKEN).digest('hex');
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000009';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const LOG_ID = `wlog-${'b'.repeat(30)}`;

function offer() {
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    sourceRevision: 1,
    sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [],
    createdAtMs: 1,
  });
  return createClusterRemoteExecutionOffer({
    offerId: 'offer-completion-1',
    deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate: {
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevision: TASK_REVISION,
      priority: 1,
      queuedAtMs: 10,
      attemptCreatedAtMs: 11,
      attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: { workerId: 'edge-1', sessionId: SESSION_ID, generation: 2 },
    lease: {
      attemptId: ATTEMPT_ID,
      runId: RUN_ID,
      status: 'leased',
      version: 0,
      leaseGeneration: 1,
      workerId: 'edge-1',
      workerSessionId: SESSION_ID,
      workerGeneration: 2,
      leaseTokenDigest: digestRunDispatchLeaseToken(LEASE_TOKEN),
      acquiredAtMs: 20,
      renewedAtMs: 20,
      expiresAtMs: 30_020,
      updatedAtMs: 20,
    },
    leaseToken: LEASE_TOKEN,
    executionRevision,
    placementScore: 0,
  });
}

function launchingRecord() {
  const accepted = createWorkerRemoteExecutionInboxRecord(offer(), 100);
  const starting = {
    ...accepted,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: 101,
  };
  const launching = {
    ...starting,
    revision: 2,
    state: 'launching',
    updatedAtMs: 102,
    executorStartedAtMs: 100,
    logArtifactId: LOG_ID,
    completionReceiptCallbackSequence: 1,
    completionReceiptTokenDigest: TOKEN_DIGEST,
  };
  assertWorkerRemoteExecutionInboxTransition(accepted, starting);
  assertWorkerRemoteExecutionInboxTransition(starting, launching);
  return launching;
}

function harness(overrides = {}) {
  let record = launchingRecord();
  let removed = 0;
  let uploaded = false;
  let completed = false;
  let artifactClosed = false;
  const receipt = {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    token: TOKEN.toString('base64url'),
    startedAtMs: 100,
    finishedAtMs: 200,
    exitCode: 0,
    ...overrides.receipt,
  };
  const inbox = {
    async readOffer(id) { return id === record.offer.offerId ? record : undefined; },
    async replaceOffer(next, expectedRevision) {
      assert.equal(expectedRevision, record.revision);
      assertWorkerRemoteExecutionInboxTransition(record, next);
      record = next;
    },
  };
  const receipts = {
    async read() {
      if (overrides.readReceipt) return overrides.readReceipt();
      return receipt;
    },
    async remove() {
      assert.equal(record.state, 'completion_acknowledged');
      removed += 1;
      return true;
    },
  };
  const artifacts = {
    async open() {
      return {
        logArtifactId: LOG_ID,
        byteLength: 3,
        truncated: false,
        async *chunks() { yield Buffer.from('log'); },
        async close() { artifactClosed = true; },
      };
    },
  };
  const uploader = {
    async upload(command) {
      assert.equal(command.workerId, 'edge-1');
      assert.equal(command.workerSessionId, SESSION_ID);
      assert.equal(command.workerGeneration, 2);
      assert.equal(command.offerId, 'offer-completion-1');
      assert.equal(command.leaseGeneration, 1);
      assert.equal(command.leaseToken, LEASE_TOKEN);
      assert.equal(command.expectedLeaseVersion, 0);
      const chunks = [];
      for await (const chunk of command.content) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.equal(body.toString(), 'log');
      uploaded = true;
      if (overrides.upload) return overrides.upload(command, body);
      return {
        status: 'stored',
        logArtifactId: command.logArtifactId,
        byteLength: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
    },
  };
  const completion = {
    async complete(command) {
      assert.equal(uploaded, true);
      assert.equal(record.state, 'launching');
      assert.equal(removed, 0);
      assert.equal(command.callbackTokenDigest, TOKEN_DIGEST);
      assert.equal(command.artifact.logArtifactId, LOG_ID);
      completed = true;
      return overrides.complete?.(command) ?? {
        status: 'applied',
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
        callbackSequence: 1,
      };
    },
  };
  const coordinator = new WorkerRemoteCompletionCoordinator(
    inbox,
    receipts,
    artifacts,
    uploader,
    completion,
    {
      currentSession: () => ({
        workerId: 'edge-1',
        sessionId: SESSION_ID,
        generation: 2,
        status: 'available',
        leaseExpiresAtMs: 30_000,
      }),
      now: () => 1_000,
    },
  );
  return {
    coordinator,
    record: () => record,
    removed: () => removed,
    uploaded: () => uploaded,
    completed: () => completed,
    artifactClosed: () => artifactClosed,
  };
}

test('uploads before completion and deletes the receipt only after durable ACK', async () => {
  const fixture = harness();
  const result = await fixture.coordinator.recover('offer-completion-1');
  assert.deepEqual(result, {
    offerId: 'offer-completion-1',
    status: 'completion_acknowledged',
    receiptCleanup: 'removed',
  });
  assert.equal(fixture.record().state, 'completion_acknowledged');
  assert.equal(fixture.uploaded(), true);
  assert.equal(fixture.completed(), true);
  assert.equal(fixture.removed(), 1);
  assert.equal(fixture.artifactClosed(), true);
});

test('recovers a receipt from the durable launching crash window', async () => {
  const fixture = harness();
  await fixture.coordinator.recover('offer-completion-1');
  assert.equal(fixture.record().executorHandle, undefined);
  assert.equal(fixture.record().executorStartedAtMs, 100);
  assert.equal(fixture.record().state, 'completion_acknowledged');
});

test('rejects a non-matching raw capability before upload', async () => {
  const fixture = harness({
    receipt: { token: Buffer.alloc(32, 0x42).toString('base64url') },
  });
  assert.deepEqual(await fixture.coordinator.recover('offer-completion-1'), {
    offerId: 'offer-completion-1',
    status: 'receipt_invalid',
  });
  assert.equal(fixture.uploaded(), false);
  assert.equal(fixture.completed(), false);
  assert.equal(fixture.removed(), 0);
});

test('distinguishes unavailable receipt storage from invalid evidence', async () => {
  const fixture = harness({
    readReceipt() { throw new Error('storage unavailable'); },
  });
  assert.deepEqual(await fixture.coordinator.recover('offer-completion-1'), {
    offerId: 'offer-completion-1',
    status: 'receipt_unavailable',
  });
  assert.equal(fixture.uploaded(), false);
  assert.equal(fixture.removed(), 0);
});

test('keeps durable evidence when upload fails', async () => {
  const fixture = harness({
    upload() { throw new Error('network unavailable'); },
  });
  await assert.rejects(
    fixture.coordinator.recover('offer-completion-1'),
    /network unavailable/,
  );
  assert.equal(fixture.record().state, 'launching');
  assert.equal(fixture.completed(), false);
  assert.equal(fixture.removed(), 0);
  assert.equal(fixture.artifactClosed(), true);
});
