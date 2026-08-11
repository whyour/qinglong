require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerExecutionOfferFileJournal,
} = require('../../back/runtime/adapters/fs/workerExecutionOfferFileJournal');
const {
  WorkerExecutionOfferReceiver,
  WorkerExecutionOfferExpiredError,
  WorkerExecutionOfferTargetError,
} = require('../../back/runtime/application/workerExecutionOfferReceiver');
const {
  WorkerExecutionOfferConflictError,
  createWorkerExecutionOfferJournalRecord,
} = require('../../back/runtime/domain/workerExecutionOffer');
const {
  createWorkerExecutionCompletionReceiptAuthentication,
} = require('../../back/runtime/domain/workerExecutionCompletionReceiptAuthentication');
const {
  createExecutionSpecDigest,
  createRunDispatchOfferId,
} = require('../../back/runtime/domain/runDispatchOffer');

const START = 1_760_400_000_000;
const SESSION = '019f7e00-0000-7000-8000-000000000001';
const REPLACEMENT_SESSION = '019f7e00-0000-7000-8000-000000000002';
const COMPLETION_TOKEN =
  'worker_completion_capability_abcdefghijklmnopqrstuvwxyz01';

function offer(overrides = {}) {
  const lease = {
    attemptId: 'attempt-1',
    runId: 'run-1',
    status: 'leased',
    version: 0,
    leaseGeneration: 1,
    workerId: 'worker-edge',
    workerSessionId: SESSION,
    workerGeneration: 1,
    leaseToken: 'lease_token_abcdefghijklmnopqrstuvwxyz0123456789',
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
    ...overrides.executionSpec,
  };
  const candidate = {
    runId: lease.runId,
    attemptId: lease.attemptId,
    projectId: executionSpec.projectId,
    taskId: executionSpec.taskId,
    taskRevision: executionSpec.taskRevision,
    executorType: 'remote_worker',
    priority: 0,
    queuedAtMs: START,
    attemptCreatedAtMs: START,
    ...overrides.candidate,
  };
  return {
    offerId: createRunDispatchOfferId(lease),
    executionSpecDigest: createExecutionSpecDigest(executionSpec),
    deliveryKind: 'new_claim',
    candidate,
    worker: {
      id: lease.workerId,
      sessionId: lease.workerSessionId,
      generation: lease.workerGeneration,
    },
    lease,
    executionSpec,
    ...overrides.offer,
  };
}

function session(overrides = {}) {
  return {
    id: 'worker-edge',
    sessionId: SESSION,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
      features: ['direct_file_log'],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 2,
    availableSlots: 2,
    registeredAtMs: START,
    lastHeartbeatAtMs: START,
    leaseExpiresAtMs: START + 120_000,
    updatedAtMs: START,
    ...overrides,
  };
}

function leaseTracker() {
  const tracked = new Map();
  return {
    track(lease) {
      tracked.set(lease.attemptId, { ...lease });
    },
    untrack(attemptId) {
      const value = tracked.get(attemptId);
      tracked.delete(attemptId);
      return value;
    },
    leases() {
      return [...tracked.values()].map((lease) => ({ ...lease }));
    },
  };
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-offer-receiver-'));
  const calls = [];
  const journal = new WorkerExecutionOfferFileJournal(root, {
    maximumEntries: 8,
  });
  await journal.acquireOwnership();
  const tracker = overrides.tracker || leaseTracker();
  const activation = {
    async acknowledgeStarting(command) {
      calls.push(['starting', command]);
      return {
        status: 'applied',
        run: {},
        attempt: {},
        lease: { ...overrides.startingLease, ...commandToLease(command) },
        events: [],
      };
    },
    async acknowledgeRunning(command) {
      calls.push(['running', command]);
      return {
        status: 'applied',
        run: {},
        attempt: {},
        lease: commandToLease(command),
        events: [],
      };
    },
    async failStart(command) {
      calls.push(['fail', command]);
      return {
        status: 'applied',
        run: {},
        attempt: {},
        lease: {
          ...commandToLease(command),
          status: 'completed',
          completedAtMs: START + 10,
          expiresAtMs: START + 60_000,
        },
        events: [],
      };
    },
    ...overrides.activation,
  };
  const executor = {
    type: 'local_process',
    capabilities() {
      return {};
    },
    async start(spec) {
      calls.push(['executor.start', spec.attemptId]);
      return {
        id: 'local-handle-1',
        durableHandle: 'local-process:durable-handle-1',
        executorType: 'local_process',
        runId: spec.runId,
        attemptId: spec.attemptId,
        startedAtMs: START + 5,
        completion: new Promise(() => undefined),
      };
    },
    async stop() {
      calls.push(['executor.stop']);
      return {
        status: 'termination_requested',
        termSignalSent: true,
        killSignalSent: false,
      };
    },
    async inspect() {
      return { status: 'running' };
    },
    ...overrides.executor,
  };
  const contexts = {
    async prepare(delivered) {
      calls.push(['context.prepare', delivered.offerId]);
      return {
        context: {
          environment: {},
          output: { async write() {} },
          completionCallback: {
            token: COMPLETION_TOKEN,
            callbackSequence: 1,
          },
        },
        logArtifactId: 'artifact-1',
      };
    },
    ...overrides.contexts,
  };
  let current = overrides.session || session();
  const receiver = new WorkerExecutionOfferReceiver(
    journal,
    activation,
    executor,
    tracker,
    contexts,
    {
      currentSession: () => current,
      clock: { now: () => START + 1 },
    },
  );
  t.after(async () => {
    await journal.releaseOwnership();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    journal,
    tracker,
    calls,
    receiver,
    setSession(value) {
      current = value;
    },
  };
}

function commandToLease(command) {
  return {
    attemptId: command.attemptId,
    runId: command.runId,
    status: 'leased',
    version: command.expectedLeaseVersion,
    leaseGeneration: command.leaseGeneration,
    workerId: command.workerId,
    workerSessionId: command.workerSessionId,
    workerGeneration: command.workerGeneration,
    leaseToken: command.leaseToken,
    acquiredAtMs: START,
    renewedAtMs: START,
    expiresAtMs: START + 60_000,
    updatedAtMs: START,
  };
}

test('persists every ACK/start boundary and deduplicates a replay', async (t) => {
  const context = await fixture(t);
  const delivered = offer();
  const result = await context.receiver.receive(delivered);
  assert.deepEqual(result, {
    status: 'running',
    offerId: delivered.offerId,
    executorHandle: 'local-process:durable-handle-1',
  });
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['starting', 'context.prepare', 'executor.start', 'running'],
  );
  const persisted = await context.journal.read(delivered.offerId);
  assert.equal(persisted.state, 'running_acknowledged');
  assert.equal(persisted.executorHandle, 'local-process:durable-handle-1');
  assert.deepEqual(
    {
      callbackSequence: persisted.completionReceiptCallbackSequence,
      tokenDigest: persisted.completionReceiptTokenDigest,
    },
    createWorkerExecutionCompletionReceiptAuthentication({
      token: COMPLETION_TOKEN,
      callbackSequence: 1,
    }),
  );
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(COMPLETION_TOKEN));

  assert.equal(
    (await context.receiver.receive(delivered)).status,
    'already_running',
  );
  assert.equal(
    context.calls.filter(([name]) => name === 'executor.start').length,
    1,
  );
});

test('rejects same offer authority with a different canonical spec', async (t) => {
  const context = await fixture(t);
  const delivered = offer();
  await context.receiver.receive(delivered);
  const conflicting = offer({
    executionSpec: {
      command: { kind: 'argv', file: '/bin/false', args: [] },
    },
  });
  await assert.rejects(
    context.receiver.receive(conflicting),
    WorkerExecutionOfferConflictError,
  );
  assert.equal(
    context.calls.filter(([name]) => name === 'executor.start').length,
    1,
  );
});

test('rejects expired, replaced-session and draining new offers before journaling', async (t) => {
  const context = await fixture(t);
  const expired = offer({ lease: { expiresAtMs: START + 1 } });
  await assert.rejects(
    context.receiver.receive(expired),
    WorkerExecutionOfferExpiredError,
  );
  context.setSession(
    session({ sessionId: '019f7e00-0000-7000-8000-000000000002' }),
  );
  await assert.rejects(
    context.receiver.receive(offer()),
    WorkerExecutionOfferTargetError,
  );
  context.setSession(session({ status: 'draining' }));
  await assert.rejects(
    context.receiver.receive(offer()),
    WorkerExecutionOfferTargetError,
  );
  assert.equal((await context.journal.list()).records.length, 0);
});

test('allows lease recovery while draining but still starts only once', async (t) => {
  const context = await fixture(t, {
    session: session({ status: 'draining' }),
  });
  const delivered = offer({ offer: { deliveryKind: 'lease_recovery' } });
  assert.equal((await context.receiver.receive(delivered)).status, 'running');
  assert.equal(
    context.calls.filter(([name]) => name === 'executor.start').length,
    1,
  );
});

test('turns a restart-visible launching record into recovery_required without spawning', async (t) => {
  const context = await fixture(t);
  const delivered = offer();
  const accepted = createWorkerExecutionOfferJournalRecord(delivered, START);
  await context.journal.create(accepted);
  const starting = {
    ...accepted,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: START + 1,
  };
  await context.journal.replace(starting, 0);
  const launching = {
    ...starting,
    revision: 2,
    state: 'launching',
    updatedAtMs: START + 2,
  };
  await context.journal.replace(launching, 1);

  assert.deepEqual(await context.receiver.receive(delivered), {
    status: 'recovery_required',
    offerId: delivered.offerId,
    reason: 'launch_outcome_unknown',
  });
  assert.equal(context.calls.length, 0);
  assert.equal(
    (await context.journal.read(delivered.offerId)).state,
    'recovery_required',
  );
});

test('replays running ACK from a durable started record without a second spawn', async (t) => {
  const context = await fixture(t);
  const delivered = offer();
  const accepted = createWorkerExecutionOfferJournalRecord(delivered, START);
  await context.journal.create(accepted);
  const starting = {
    ...accepted,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: START + 1,
  };
  await context.journal.replace(starting, 0);
  const launching = {
    ...starting,
    revision: 2,
    state: 'launching',
    updatedAtMs: START + 2,
  };
  await context.journal.replace(launching, 1);
  const started = {
    ...launching,
    revision: 3,
    state: 'started',
    updatedAtMs: START + 3,
    executorHandle: 'local-process:durable-handle-1',
    executorStartedAtMs: START + 2,
  };
  await context.journal.replace(started, 2);

  assert.equal((await context.receiver.receive(delivered)).status, 'running');
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['running'],
  );
});

test('durably reports a rejected executor start and replays no side effects', async (t) => {
  const context = await fixture(t, {
    executor: {
      async start() {
        context.calls.push(['executor.start']);
        throw new Error('spawn rejected');
      },
    },
  });
  const delivered = offer();
  assert.equal(
    (await context.receiver.receive(delivered)).status,
    'start_failed',
  );
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['starting', 'context.prepare', 'executor.start', 'fail'],
  );
  assert.equal(
    (await context.journal.read(delivered.offerId)).state,
    'start_failure_acknowledged',
  );
  assert.equal(
    (await context.receiver.receive(delivered)).status,
    'already_failed',
  );
  assert.equal(
    context.calls.filter(([name]) => name === 'executor.start').length,
    1,
  );
});

test('rejects an invalid completion capability before the spawn barrier', async (t) => {
  const context = await fixture(t, {
    contexts: {
      async prepare() {
        context.calls.push(['context.prepare']);
        return {
          context: {
            environment: {},
            output: { async write() {} },
            completionCallback: {
              token: 'too-short',
              callbackSequence: 1,
            },
          },
        };
      },
    },
  });
  const delivered = offer();
  assert.equal(
    (await context.receiver.receive(delivered)).status,
    'start_failed',
  );
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['starting', 'context.prepare', 'fail'],
  );
  const persisted = await context.journal.read(delivered.offerId);
  assert.equal(persisted.state, 'start_failure_acknowledged');
  assert.equal(persisted.completionReceiptTokenDigest, undefined);
});

test('coalesces concurrent duplicate delivery into one journal/start operation', async (t) => {
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const context = await fixture(t, {
    executor: {
      async start(spec) {
        context.calls.push(['executor.start', spec.attemptId]);
        await startGate;
        return {
          id: 'local-handle-concurrent',
          executorType: 'local_process',
          runId: spec.runId,
          attemptId: spec.attemptId,
          startedAtMs: START + 5,
          completion: new Promise(() => undefined),
        };
      },
    },
  });
  const delivered = offer();
  const first = context.receiver.receive(delivered);
  const second = context.receiver.receive(delivered);
  assert.strictEqual(first, second);
  releaseStart();
  assert.equal((await first).status, 'running');
  assert.equal(
    context.calls.filter(([name]) => name === 'executor.start').length,
    1,
  );
});

test('does not spawn when the control plane already owns a running execution', async (t) => {
  const context = await fixture(t, {
    activation: {
      async acknowledgeStarting(command) {
        context.calls.push(['starting', command]);
        return {
          status: 'already_running',
          run: {},
          attempt: {},
          lease: commandToLease(command),
          events: [],
        };
      },
    },
  });
  const delivered = offer();
  assert.deepEqual(await context.receiver.receive(delivered), {
    status: 'recovery_required',
    offerId: delivered.offerId,
    reason: 'control_plane_already_running',
  });
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ['starting'],
  );
});

test('returns an already completed result for a durable terminal redelivery', async (t) => {
  const context = await fixture(t);
  const delivered = offer();
  const initial = createWorkerExecutionOfferJournalRecord(delivered, START);
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: COMPLETION_TOKEN,
    callbackSequence: 1,
  });
  await context.journal.create(initial);
  await context.journal.replace(
    {
      ...initial,
      revision: 1,
      state: 'completion_acknowledged',
      updatedAtMs: START + 1,
      completionReceiptCallbackSequence: authentication.callbackSequence,
      completionReceiptTokenDigest: authentication.tokenDigest,
      completionAcknowledgedAtMs: START + 1,
    },
    0,
  );
  context.setSession(
    session({ sessionId: REPLACEMENT_SESSION, generation: 2 }),
  );

  assert.deepEqual(await context.receiver.receive(delivered), {
    status: 'already_completed',
    offerId: delivered.offerId,
  });
  assert.deepEqual(context.calls, []);
});

test('never restarts a durable execution after lease-loss stop acknowledgement', async (t) => {
  const context = await fixture(t);
  const delivered = offer();
  const initial = createWorkerExecutionOfferJournalRecord(delivered, START);
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: COMPLETION_TOKEN,
    callbackSequence: 1,
  });
  await context.journal.create(initial);
  await context.journal.replace(
    {
      ...initial,
      revision: 1,
      state: 'recovery_required',
      updatedAtMs: START + 1,
      executorHandle: 'local-process:durable-handle-1',
      executorStartedAtMs: START + 1,
      completionReceiptCallbackSequence: authentication.callbackSequence,
      completionReceiptTokenDigest: authentication.tokenDigest,
      recoveryReason: 'lease_lost_local_execution_stopped',
    },
    0,
  );

  assert.deepEqual(await context.receiver.receive(delivered), {
    status: 'recovery_required',
    offerId: delivered.offerId,
    reason: 'lease_lost_local_execution_stopped',
  });
  assert.deepEqual(context.calls, []);
});
