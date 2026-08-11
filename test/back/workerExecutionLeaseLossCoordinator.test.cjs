require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerExecutionLeaseLossCoordinator,
} = require('../../back/runtime/application/workerExecutionLeaseLossCoordinator');
const {
  cloneWorkerExecutionOfferJournalRecord,
  createWorkerExecutionOfferJournalRecord,
} = require('../../back/runtime/domain/workerExecutionOffer');
const {
  createWorkerExecutionCompletionReceiptAuthentication,
} = require('../../back/runtime/domain/workerExecutionCompletionReceiptAuthentication');
const {
  createExecutionSpecDigest,
  createRunDispatchOfferId,
} = require('../../back/runtime/domain/runDispatchOffer');

const START = 1_760_900_000_000;
const RUN_ID = '019f8300-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f8300-0000-7000-8000-000000000002';
const SESSION_ID = '019f8300-0000-7000-8000-000000000003';
const RECEIPT_TOKEN = 'receipt_capability_abcdefghijklmnopqrstuvwxyz012345';

function offer() {
  const lease = {
    attemptId: ATTEMPT_ID,
    runId: RUN_ID,
    status: 'leased',
    version: 3,
    leaseGeneration: 2,
    workerId: 'worker-edge',
    workerSessionId: SESSION_ID,
    workerGeneration: 4,
    leaseToken: 'lease_capability_abcdefghijklmnopqrstuvwxyz0123456',
    acquiredAtMs: START,
    renewedAtMs: START + 10,
    expiresAtMs: START + 1_000,
    updatedAtMs: START + 10,
  };
  const executionSpec = {
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 1_000,
  };
  return {
    offerId: createRunDispatchOfferId(lease),
    executionSpecDigest: createExecutionSpecDigest(executionSpec),
    deliveryKind: 'new_claim',
    candidate: {
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      projectId: 'default',
      taskId: 'task-1',
      taskRevision: 'revision-1',
      executorType: 'remote_worker',
      priority: 0,
      queuedAtMs: START,
      attemptCreatedAtMs: START,
    },
    worker: {
      id: 'worker-edge',
      sessionId: SESSION_ID,
      generation: 4,
    },
    lease,
    executionSpec,
  };
}

function record(state = 'running_acknowledged') {
  const initial = createWorkerExecutionOfferJournalRecord(offer(), START);
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: RECEIPT_TOKEN,
    callbackSequence: 1,
  });
  const ownsExecution =
    state === 'started' ||
    state === 'running_acknowledged' ||
    state === 'recovery_required';
  return cloneWorkerExecutionOfferJournalRecord({
    ...initial,
    revision: 5,
    state,
    updatedAtMs: START + 20,
    ...(state === 'launching' || ownsExecution
      ? {
          completionReceiptCallbackSequence: authentication.callbackSequence,
          completionReceiptTokenDigest: authentication.tokenDigest,
        }
      : {}),
    ...(ownsExecution
      ? {
          executorHandle: 'ql3lp1.durable-handle',
          executorStartedAtMs: START + 15,
        }
      : {}),
    ...(state === 'recovery_required'
      ? { recoveryReason: 'launch_outcome_unknown' }
      : {}),
    ...(state === 'completion_acknowledged'
      ? {
          completionReceiptCallbackSequence: authentication.callbackSequence,
          completionReceiptTokenDigest: authentication.tokenDigest,
          completionAcknowledgedAtMs: START + 20,
        }
      : {}),
  });
}

class MemoryJournal {
  constructor(value) {
    this.value = cloneWorkerExecutionOfferJournalRecord(value);
    this.replaceCalls = 0;
  }

  async read(offerId) {
    if (this.value?.offer.offerId !== offerId) return undefined;
    return cloneWorkerExecutionOfferJournalRecord(this.value);
  }

  async replace(value, expectedRevision) {
    this.replaceCalls += 1;
    assert.equal(this.value.revision, expectedRevision);
    this.value = cloneWorkerExecutionOfferJournalRecord(value);
  }
}

function loss(overrides = {}) {
  return {
    lease: { ...offer().lease, ...overrides.lease },
    reason: overrides.reason || 'lease_expired',
  };
}

function fixture(options = {}) {
  const journal = new MemoryJournal(options.record || record());
  const calls = [];
  const controller = {
    executorType: 'local_process',
    async stop(command) {
      calls.push(command);
      if (options.barrier) await options.barrier;
      if (options.stopError) throw options.stopError;
      return {
        status: options.stopStatus || 'termination_requested',
        termSignalSent: options.stopStatus !== 'already_exited',
        killSignalSent: false,
      };
    },
  };
  const coordinator = new WorkerExecutionLeaseLossCoordinator(
    journal,
    controller,
    { clock: { now: () => START + 2_000 } },
  );
  return { calls, coordinator, journal };
}

test('stops only the durable execution bound to the exact lost lease', async () => {
  const context = fixture();
  const result = await context.coordinator.reconcile(loss());
  assert.equal(result.status, 'stop_acknowledged');
  assert.equal(result.stopStatus, 'termination_requested');
  assert.deepEqual(context.calls, [
    {
      durableHandle: 'ql3lp1.durable-handle',
      reason: { kind: 'reconcile', requestedAtMs: START + 2_000 },
    },
  ]);
  assert.equal(context.journal.value.state, 'recovery_required');
  assert.equal(
    context.journal.value.recoveryReason,
    'lease_lost_local_execution_stopped',
  );
  assert.equal(context.journal.value.revision, 6);
});

test('persists an unverified outcome without claiming that a mismatched identity stopped', async () => {
  const context = fixture({ stopStatus: 'identity_mismatch' });
  const result = await context.coordinator.reconcile(
    loss({ reason: 'worker_session_replaced' }),
  );
  assert.equal(result.status, 'stop_unverified');
  assert.equal(result.stopStatus, 'identity_mismatch');
  assert.equal(
    context.journal.value.recoveryReason,
    'lease_lost_local_execution_unverified',
  );
});

test('fails closed when launch ownership has no durable handle', async () => {
  const context = fixture({ record: record('launching') });
  const result = await context.coordinator.reconcile(loss());
  assert.equal(result.status, 'stop_unverified');
  assert.deepEqual(context.calls, []);
  assert.equal(
    context.journal.value.recoveryReason,
    'lease_lost_local_execution_unverified',
  );
});

test('never stops an execution after local completion is acknowledged', async () => {
  const context = fixture({ record: record('completion_acknowledged') });
  const result = await context.coordinator.reconcile(loss());
  assert.equal(result.status, 'already_completed');
  assert.deepEqual(context.calls, []);
  assert.equal(context.journal.replaceCalls, 0);
});

test('treats a persisted loss outcome as idempotent', async () => {
  const current = record('recovery_required');
  current.recoveryReason = 'lease_lost_local_execution_stopped';
  const context = fixture({ record: current });
  const result = await context.coordinator.reconcile(loss());
  assert.equal(result.status, 'already_stopped');
  assert.deepEqual(context.calls, []);
  assert.equal(context.journal.replaceCalls, 0);
});

test('coalesces concurrent loss callbacks for one offer', async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const context = fixture({ barrier });
  const first = context.coordinator.reconcile(loss());
  const second = context.coordinator.reconcile(
    loss({ reason: 'worker_unavailable' }),
  );
  release();
  assert.strictEqual(await first, await second);
  assert.equal(context.calls.length, 1);
  assert.equal(context.journal.replaceCalls, 1);
});

test('does not persist a stopped claim when process control fails', async () => {
  const context = fixture({ stopError: new Error('controller unavailable') });
  await assert.rejects(
    context.coordinator.reconcile(loss()),
    /controller unavailable/,
  );
  assert.equal(context.journal.value.state, 'running_acknowledged');
  assert.equal(context.journal.replaceCalls, 0);
});
