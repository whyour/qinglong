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
  WorkerRemoteExecutionControlCoordinator,
} = require('../dist/execution/workerExecutionControlCoordinator');

const RUN_ID = '019f70e0-0000-7000-8000-000000000301';
const ATTEMPT_ID = '019f70e0-0000-7000-8000-000000000302';
const SESSION_ID = '019f70e0-0000-7000-8000-000000000303';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000010';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const LOG_ID = `wlog-${'b'.repeat(30)}`;
const RECEIPT_DIGEST = createHash('sha256').update(Buffer.alloc(32, 1)).digest('hex');

function offer(expiresAtMs = 30_020) {
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1', taskId: 'task-1', taskRevision: TASK_REVISION,
    sourceRevision: 1, sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker', planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [], createdAtMs: 1,
  });
  return createClusterRemoteExecutionOffer({
    offerId: 'offer-control-1', deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate: {
      runId: RUN_ID, attemptId: ATTEMPT_ID, projectId: 'project-1',
      taskId: 'task-1', taskRevision: TASK_REVISION, priority: 1,
      queuedAtMs: 10, attemptCreatedAtMs: 11, attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: { workerId: 'edge-1', sessionId: SESSION_ID, generation: 2 },
    lease: {
      attemptId: ATTEMPT_ID, runId: RUN_ID, status: 'leased', version: 0,
      leaseGeneration: 1, workerId: 'edge-1', workerSessionId: SESSION_ID,
      workerGeneration: 2, leaseTokenDigest: digestRunDispatchLeaseToken(LEASE_TOKEN),
      acquiredAtMs: 20, renewedAtMs: 20, expiresAtMs, updatedAtMs: 20,
    },
    leaseToken: LEASE_TOKEN, executionRevision, placementScore: 0,
  });
}

function runningRecord(expiresAtMs) {
  const accepted = createWorkerRemoteExecutionInboxRecord(offer(expiresAtMs), 100);
  const starting = { ...accepted, revision: 1, state: 'starting_acknowledged', updatedAtMs: 101 };
  const launching = {
    ...starting, revision: 2, state: 'launching', updatedAtMs: 102,
    executorStartedAtMs: 100, logArtifactId: LOG_ID,
    completionReceiptCallbackSequence: 1,
    completionReceiptTokenDigest: RECEIPT_DIGEST,
  };
  const started = {
    ...launching, revision: 3, state: 'started', updatedAtMs: 103,
    executorHandle: 'ql3lp1.durable-handle',
  };
  const running = { ...started, revision: 4, state: 'running_acknowledged', updatedAtMs: 104 };
  assertWorkerRemoteExecutionInboxTransition(accepted, starting);
  assertWorkerRemoteExecutionInboxTransition(starting, launching);
  assertWorkerRemoteExecutionInboxTransition(launching, started);
  assertWorkerRemoteExecutionInboxTransition(started, running);
  return running;
}

function fixture(overrides = {}) {
  let record = runningRecord(overrides.expiresAtMs ?? 30_020);
  const calls = [];
  const inbox = {
    async readOffer(id) { return id === record.offer.offerId ? record : undefined; },
    async replaceOffer(next, expectedRevision) {
      assert.equal(expectedRevision, record.revision);
      assertWorkerRemoteExecutionInboxTransition(record, next);
      record = next;
      calls.push(`persist:${record.offer.lease.version}:${record.state}`);
    },
  };
  const completion = {
    async recover() {
      calls.push('completion');
      return overrides.completionResult ?? {
        offerId: record.offer.offerId, status: 'receipt_missing',
      };
    },
  };
  const leaseControl = {
    async control(command) {
      calls.push(`control:${command.expectedLeaseVersion}`);
      if (overrides.control) return overrides.control(command, () => record);
      return {
        status: 'renewed', projectId: command.projectId, runId: command.runId,
        attemptId: command.attemptId, offerId: command.offerId,
        leaseGeneration: command.leaseGeneration,
        leaseVersion: command.expectedLeaseVersion + 1,
        renewedAtMs: 1_000, expiresAtMs: 31_000,
      };
    },
  };
  const processes = {
    async stop(handle) {
      calls.push(`stop:${handle}:v${record.offer.lease.version}`);
      return overrides.stopResult ?? { status: 'stopped', signal: 'SIGTERM' };
    },
  };
  const coordinator = new WorkerRemoteExecutionControlCoordinator(
    inbox, completion, leaseControl, processes,
    {
      currentSession: () => overrides.session === null ? undefined : {
        workerId: 'edge-1', sessionId: SESSION_ID, generation: 2,
        status: 'available', leaseExpiresAtMs: 60_000,
        ...overrides.session,
      },
      now: () => overrides.now ?? 500,
    },
  );
  return { coordinator, calls, record: () => record };
}

test('replays completion first, renews authority, then persists the next lease version', async () => {
  const f = fixture();
  assert.deepEqual(await f.coordinator.reconcile('offer-control-1'), {
    offerId: 'offer-control-1', status: 'renewed', leaseVersion: 1,
    expiresAtMs: 31_000, completionStatus: 'receipt_missing',
  });
  assert.deepEqual(f.calls, ['completion', 'control:0', 'persist:1:running_acknowledged']);
  assert.equal(f.record().offer.lease.renewedAtMs, 1_000);
});

test('persists stop-request lease authority before stopping the exact process', async () => {
  const f = fixture({
    control(command) {
      return {
        status: 'stop_requested', projectId: command.projectId,
        runId: command.runId, attemptId: command.attemptId,
        offerId: command.offerId, leaseGeneration: command.leaseGeneration,
        leaseVersion: 1, renewedAtMs: 1_000, expiresAtMs: 31_000,
        stop: { reason: 'timeout', requestedAtMs: 900 },
      };
    },
  });
  const result = await f.coordinator.reconcile('offer-control-1');
  assert.equal(result.status, 'stop_requested');
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(f.calls, [
    'completion', 'control:0', 'persist:1:running_acknowledged',
    'stop:ql3lp1.durable-handle:v1',
  ]);
});

test('stops locally and records conclusive recovery after lease expiry', async () => {
  const f = fixture({ expiresAtMs: 400, now: 500 });
  const result = await f.coordinator.reconcile('offer-control-1');
  assert.equal(result.status, 'lease_expired');
  assert.equal(result.recoveryReason, 'lease_lost_local_execution_stopped');
  assert.equal(f.record().state, 'recovery_required');
  assert.equal(f.record().recoveryReason, 'lease_lost_local_execution_stopped');
  assert.equal(f.calls.some((value) => value.startsWith('control:')), false);
});

test('keeps inconclusive stop evidence distinct after lease expiry', async () => {
  const f = fixture({
    expiresAtMs: 400, now: 500,
    stopResult: { status: 'unknown', reason: 'provider_unavailable' },
  });
  const result = await f.coordinator.reconcile('offer-control-1');
  assert.equal(result.recoveryReason, 'lease_lost_local_execution_unverified');
  assert.equal(f.record().recoveryReason, 'lease_lost_local_execution_unverified');
});

test('does not contact control after completion acknowledgement', async () => {
  const f = fixture({
    completionResult: { offerId: 'offer-control-1', status: 'completion_acknowledged' },
  });
  assert.equal((await f.coordinator.reconcile('offer-control-1')).status,
    'completion_acknowledged');
  assert.deepEqual(f.calls, ['completion']);
});

test('waits for the bound Worker Session while local lease authority remains live', async () => {
  const f = fixture({ session: null });
  const result = await f.coordinator.reconcile('offer-control-1');
  assert.equal(result.status, 'session_unavailable');
  assert.equal(f.calls.some((value) => value.startsWith('control:')), false);
  assert.equal(f.calls.some((value) => value.startsWith('stop:')), false);
});

test('stops and quarantines execution when the control plane is terminal', async () => {
  const f = fixture({
    control(command) {
      return {
        status: 'terminal', projectId: command.projectId, runId: command.runId,
        attemptId: command.attemptId, offerId: command.offerId,
        leaseGeneration: command.leaseGeneration, terminalStatus: 'cancelled',
      };
    },
  });
  const result = await f.coordinator.reconcile('offer-control-1');
  assert.equal(result.status, 'terminal');
  assert.equal(result.terminalStatus, 'cancelled');
  assert.equal(f.record().recoveryReason, 'control_plane_terminal');
});

test('coalesces concurrent supervision for the same offer', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    async control(command) {
      await gate;
      return {
        status: 'renewed', projectId: command.projectId, runId: command.runId,
        attemptId: command.attemptId, offerId: command.offerId,
        leaseGeneration: command.leaseGeneration, leaseVersion: 1,
        renewedAtMs: 1_000, expiresAtMs: 31_000,
      };
    },
  });
  const first = f.coordinator.reconcile('offer-control-1');
  const second = f.coordinator.reconcile('offer-control-1');
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(f.calls.filter((value) => value.startsWith('control:')).length, 1);
});
