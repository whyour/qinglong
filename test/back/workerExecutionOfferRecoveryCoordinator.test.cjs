require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  Sha256WorkerExecutionCompletionReceiptAuthenticator,
} = require('../../back/runtime/adapters/crypto/sha256WorkerExecutionCompletionReceiptAuthenticator');
const {
  WorkerExecutionOfferRecoveryCoordinator,
} = require('../../back/runtime/application/workerExecutionOfferRecoveryCoordinator');
const {
  WorkerExecutionOfferRecoveryReconciler,
} = require('../../back/runtime/application/workerExecutionOfferRecoveryReconciler');
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

const START = 1_760_800_000_000;
const RUN_ID = '019f8200-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f8200-0000-7000-8000-000000000002';
const SESSION_A = '019f8200-0000-7000-8000-000000000003';
const SESSION_B = '019f8200-0000-7000-8000-000000000004';
const RECEIPT_TOKEN = 'receipt_capability_abcdefghijklmnopqrstuvwxyz012345';

function offer(overrides = {}) {
  const lease = {
    attemptId: ATTEMPT_ID,
    runId: RUN_ID,
    status: 'leased',
    version: 2,
    leaseGeneration: 1,
    workerId: 'worker-edge',
    workerSessionId: SESSION_A,
    workerGeneration: 1,
    leaseToken: 'lease_capability_abcdefghijklmnopqrstuvwxyz0123456',
    acquiredAtMs: START,
    renewedAtMs: START,
    expiresAtMs: START + 60_000,
    updatedAtMs: START,
    ...overrides.lease,
  };
  const executionSpec = {
    runId: lease.runId,
    attemptId: lease.attemptId,
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
    deliveryKind: 'lease_recovery',
    candidate: {
      runId: lease.runId,
      attemptId: lease.attemptId,
      projectId: 'default',
      taskId: 'task-1',
      taskRevision: 'revision-1',
      executorType: 'remote_worker',
      priority: 0,
      queuedAtMs: START,
      attemptCreatedAtMs: START,
    },
    worker: {
      id: lease.workerId,
      sessionId: lease.workerSessionId,
      generation: lease.workerGeneration,
    },
    lease,
    executionSpec,
  };
}

function record(state = 'started') {
  const initial = createWorkerExecutionOfferJournalRecord(offer(), START);
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: RECEIPT_TOKEN,
    callbackSequence: 1,
  });
  return cloneWorkerExecutionOfferJournalRecord({
    ...initial,
    revision: 1,
    state,
    updatedAtMs: START + 10,
    executorHandle: 'ql3lp1.durable-handle',
    executorStartedAtMs: START + 5,
    completionReceiptCallbackSequence: authentication.callbackSequence,
    completionReceiptTokenDigest: authentication.tokenDigest,
    ...(state === 'recovery_required'
      ? { recoveryReason: 'launch_outcome_unknown' }
      : {}),
  });
}

function session(overrides = {}) {
  return {
    id: 'worker-edge',
    sessionId: SESSION_A,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { memoryBytes: 256 * 1024 * 1024 },
      features: ['direct_file_log'],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: START,
    lastHeartbeatAtMs: START,
    leaseExpiresAtMs: START + 120_000,
    updatedAtMs: START,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    token: RECEIPT_TOKEN,
    startedAtMs: START + 5,
    finishedAtMs: START + 50,
    exitCode: 0,
    ...overrides,
  };
}

class MemoryJournal {
  constructor(value) {
    this.value = cloneWorkerExecutionOfferJournalRecord(value);
    this.replaceCalls = 0;
    this.failReplace = 0;
  }

  async read(offerId) {
    if (this.value?.offer.offerId !== offerId) return undefined;
    return cloneWorkerExecutionOfferJournalRecord(this.value);
  }

  async replace(value, expectedRevision) {
    this.replaceCalls += 1;
    if (this.failReplace > 0) {
      this.failReplace -= 1;
      throw new Error('simulated journal write failure');
    }
    assert.equal(this.value.revision, expectedRevision);
    assert.equal(value.revision, expectedRevision + 1);
    this.value = cloneWorkerExecutionOfferJournalRecord(value);
  }
}

function fixture(options = {}) {
  const journal = options.journal || new MemoryJournal(record());
  const calls = [];
  let receiptValue = options.receiptValue;
  if (!Object.hasOwn(options, 'receiptValue')) receiptValue = receipt();
  let cleanupFailure = options.cleanupFailure;
  const receipts = {
    async read(attemptId) {
      calls.push(['read_receipt', attemptId]);
      if (receiptValue instanceof Error) throw receiptValue;
      if (options.readBarrier) await options.readBarrier;
      return receiptValue;
    },
    async remove(attemptId) {
      calls.push(['remove_receipt', attemptId]);
      if (cleanupFailure) {
        cleanupFailure = false;
        throw new Error('simulated receipt cleanup failure');
      }
      const removed = receiptValue !== undefined;
      receiptValue = undefined;
      return removed;
    },
  };
  const reconciler = new WorkerExecutionOfferRecoveryReconciler(
    receipts,
    new Sha256WorkerExecutionCompletionReceiptAuthenticator(),
    {
      executorType: 'local_process',
      async inspect(handle) {
        calls.push(['inspect', handle]);
        return options.inspection || { status: 'running', identityPid: 42 };
      },
    },
    { clock: { now: () => START + 55 } },
  );
  const completion = {
    async complete(command) {
      calls.push(['complete', command]);
      if (options.completionError) throw options.completionError;
      return { status: options.completionStatus || 'applied' };
    },
  };
  const activation = {
    async acknowledgeRunning(command) {
      calls.push(['ack_running', command]);
      if (options.activationError) throw options.activationError;
      return {
        status: options.activationStatus || 'applied',
        lease: { ...journal.value.offer.lease, version: 3 },
      };
    },
  };
  const coordinator = new WorkerExecutionOfferRecoveryCoordinator(
    journal,
    reconciler,
    completion,
    activation,
    receipts,
    {
      currentSession: () =>
        Object.hasOwn(options, 'currentSession')
          ? options.currentSession
          : session(),
      clock: { now: () => START + 60 },
    },
  );
  return { calls, coordinator, journal };
}

test('submits a trusted completion before terminal journal and receipt cleanup', async () => {
  const context = fixture();
  const result = await context.coordinator.recover(
    context.journal.value.offer.offerId,
  );
  assert.equal(result.status, 'completion_acknowledged');
  assert.equal(result.receiptCleanup, 'removed');
  assert.equal(context.journal.value.state, 'completion_acknowledged');
  assert.equal(context.journal.value.completionAcknowledgedAtMs, START + 60);
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['read_receipt', 'complete', 'remove_receipt'],
  );
  const command = context.calls.find(([name]) => name === 'complete')[1];
  assert.deepEqual(command.result, {
    outcome: 'succeeded',
    startedAtMs: START + 5,
    finishedAtMs: START + 50,
    exitCode: 0,
  });
  assert.equal(command.expectedLeaseVersion, 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /receipt_capability|lease_capability/,
  );
});

test('keeps the receipt when terminal journal persistence fails and converges on replay', async () => {
  const journal = new MemoryJournal(record());
  journal.failReplace = 1;
  const first = fixture({ journal });
  await assert.rejects(
    first.coordinator.recover(journal.value.offer.offerId),
    /simulated journal write failure/,
  );
  assert.equal(journal.value.state, 'started');
  assert.equal(
    first.calls.filter(([name]) => name === 'remove_receipt').length,
    0,
  );

  const replay = fixture({
    journal,
    completionStatus: 'already_terminal',
  });
  const result = await replay.coordinator.recover(journal.value.offer.offerId);
  assert.equal(result.status, 'completion_acknowledged');
  assert.equal(journal.value.state, 'completion_acknowledged');
  assert.equal(result.receiptCleanup, 'removed');
});

test('keeps a terminal journal when receipt cleanup fails and retries cleanup only', async () => {
  const context = fixture({ cleanupFailure: true });
  const offerId = context.journal.value.offer.offerId;
  const first = await context.coordinator.recover(offerId);
  assert.equal(first.status, 'completion_acknowledged');
  assert.equal(first.receiptCleanup, 'pending');
  assert.equal(context.journal.value.state, 'completion_acknowledged');

  const second = await context.coordinator.recover(offerId);
  assert.equal(second.status, 'already_completed');
  assert.equal(second.receiptCleanup, 'removed');
  assert.equal(context.calls.filter(([name]) => name === 'complete').length, 1);
});

test('fenced or untrusted evidence cannot trigger a control-plane mutation', async () => {
  const cases = [
    fixture({
      currentSession: session({ sessionId: SESSION_B, generation: 2 }),
    }),
    fixture({ receiptValue: receipt({ token: 'x'.repeat(43) }) }),
    fixture({ receiptValue: new Error('EIO') }),
  ];
  for (const context of cases) {
    const result = await context.coordinator.recover(
      context.journal.value.offer.offerId,
    );
    assert.equal(result.status, 'deferred');
    assert.equal(
      context.calls.some(([name]) =>
        ['complete', 'ack_running', 'remove_receipt'].includes(name),
      ),
      false,
    );
    assert.equal(context.journal.value.state, 'started');
  }
});

test('preserves journal and receipt when the control plane fences completion', async () => {
  const context = fixture({
    completionError: new Error('simulated control-plane fence'),
  });
  await assert.rejects(
    context.coordinator.recover(context.journal.value.offer.offerId),
    /simulated control-plane fence/,
  );
  assert.equal(context.journal.value.state, 'started');
  assert.equal(context.journal.replaceCalls, 0);
  assert.equal(
    context.calls.filter(([name]) => name === 'remove_receipt').length,
    0,
  );
});

test('recovers a running ACK only from a current started execution', async () => {
  const context = fixture({ receiptValue: undefined });
  const result = await context.coordinator.recover(
    context.journal.value.offer.offerId,
  );
  assert.equal(result.status, 'running_acknowledged');
  assert.equal(context.journal.value.state, 'running_acknowledged');
  assert.equal(context.journal.value.offer.lease.version, 3);
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['read_receipt', 'inspect', 'ack_running'],
  );
});

test('does not treat a fenced running record as recovered ownership', async () => {
  const context = fixture({
    journal: new MemoryJournal(record('running_acknowledged')),
    receiptValue: undefined,
    currentSession: session({ sessionId: SESSION_B, generation: 2 }),
  });
  const result = await context.coordinator.recover(
    context.journal.value.offer.offerId,
  );
  assert.equal(result.status, 'deferred');
  assert.equal(result.evidence.authority, 'session_fenced');
  assert.equal(
    context.calls.some(([name]) => name === 'ack_running'),
    false,
  );
});

test('records a terminal control-plane response without inventing completion', async () => {
  const context = fixture({
    receiptValue: undefined,
    activationStatus: 'already_terminal',
  });
  const result = await context.coordinator.recover(
    context.journal.value.offer.offerId,
  );
  assert.equal(result.status, 'control_plane_terminal');
  assert.equal(context.journal.value.state, 'recovery_required');
  assert.equal(context.journal.value.recoveryReason, 'control_plane_terminal');
  assert.equal(
    context.calls.some(([name]) => name === 'remove_receipt'),
    false,
  );
});

test('coalesces concurrent recovery and does nothing without a current session', async () => {
  let releaseRead;
  const readBarrier = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const concurrent = fixture({ readBarrier });
  const offerId = concurrent.journal.value.offer.offerId;
  const first = concurrent.coordinator.recover(offerId);
  const second = concurrent.coordinator.recover(offerId);
  assert.equal(first, second);
  releaseRead();
  await Promise.all([first, second]);
  assert.equal(
    concurrent.calls.filter(([name]) => name === 'complete').length,
    1,
  );

  const unavailable = fixture({ currentSession: undefined });
  const result = await unavailable.coordinator.recover(
    unavailable.journal.value.offer.offerId,
  );
  assert.equal(result.status, 'session_unavailable');
  assert.deepEqual(unavailable.calls, []);
});
