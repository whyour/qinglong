'use strict';

const assert = require('node:assert/strict');
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
  createSecretRef,
} = require('@qinglong/runtime-core/secret-reference');
const {
  WorkerRemoteExecutionInboxProcessor,
  assertWorkerRemoteExecutionInboxTransition,
  createWorkerRemoteExecutionInboxRecord,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');
const {
  WorkerInboxExecutionSpawnBarrier,
} = require('../dist/execution/workerPosixExecutionExecutor');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';

function offer(timeoutMs) {
  const executionRevision = createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    sourceRevision: 1,
    sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [
      { name: 'PUBLIC_VALUE', kind: 'public', value: 'visible' },
      {
        name: 'SECRET_VALUE',
        kind: 'secret',
        secretRef: createSecretRef({ projectId: 'project-1', name: 'item-1' }),
      },
    ],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    createdAtMs: 1,
  });
  return createClusterRemoteExecutionOffer({
    offerId: 'offer-processor-1',
    deliveryKind: 'new_claim',
    executionDigest: executionRevision.contentDigest,
    candidate: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevision: TASK_REVISION,
      priority: 1,
      queuedAtMs: 10,
      attemptCreatedAtMs: 11,
      attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: {
      workerId: 'edge-1',
      sessionId: SESSION_ID,
      generation: 2,
    },
    lease: {
      attemptId: 'attempt-1',
      runId: 'run-1',
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

function inboxFixture(initial = createWorkerRemoteExecutionInboxRecord(offer(), 100)) {
  let record = initial;
  const states = [];
  return {
    inbox: {
      async readOffer(offerId) {
        return record?.offer.offerId === offerId ? record : undefined;
      },
      async replaceOffer(next, expectedRevision) {
        assert.equal(record.revision, expectedRevision);
        assertWorkerRemoteExecutionInboxTransition(record, next);
        record = next;
        states.push(next.state);
      },
      async listOffers() { return { records: record ? [record] : [] }; },
    },
    states,
    record: () => record,
  };
}

function snapshot(overrides = {}) {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    runStatus: 'dispatching',
    attemptStatus: 'starting',
    leaseVersion: 0,
    leaseGeneration: 1,
    callbackSequence: 0,
    ...overrides,
  };
}

function outputSink(logArtifactId = 'log-1', onClose = () => undefined) {
  return {
    logArtifactId,
    async write() {},
    async close() { onClose(); },
  };
}

function options(fixture, overrides = {}) {
  let event = 0;
  const activation = overrides.activation ?? {
    async acknowledgeStarting() {
      return { status: 'already_starting', snapshot: snapshot() };
    },
    async acknowledgeRunning(command) {
      return {
        status: 'applied',
        snapshot: snapshot({
          runStatus: 'running',
          attemptStatus: 'running',
          callbackSequence: command.callbackSequence,
          executorHandle: command.executorHandle,
        }),
      };
    },
    async failStart() {
      return {
        status: 'applied',
        snapshot: snapshot({
          runStatus: 'failed',
          attemptStatus: 'failed',
          leaseVersion: 1,
          callbackSequence: 1,
        }),
      };
    },
  };
  return {
    inbox: fixture.inbox,
    activation,
    currentSession: () => ({
      workerId: 'edge-1',
      sessionId: SESSION_ID,
      generation: 2,
      status: 'available',
      leaseExpiresAtMs: 30_000,
    }),
    now: () => 1_000,
    randomCapability: () => Buffer.alloc(32, 7),
    eventId: () => `event-${++event}`,
    materializer: overrides.materializer ?? {
      async prepare() {
        const output = outputSink();
        let taken = false;
        return {
          environment: [
            { name: 'SECRET_VALUE', value: 'resolved-secret' },
            { name: 'PUBLIC_VALUE', value: 'visible' },
          ],
          logArtifactId: 'log-1',
          takeOutput() {
            assert.equal(taken, false);
            taken = true;
            return output;
          },
        };
      },
    },
    executor: overrides.executor ?? {
      async start(launch) {
        return {
          status: 'started', executorHandle: 'process-1',
          executorStartedAtMs: launch.executorStartedAtMs,
        };
      },
    },
  };
}

test('persists every ACK and spawn barrier in the one delivery inbox', async () => {
  const fixture = inboxFixture();
  let startingCalls = 0;
  let launchedToken;
  let runningCommand;
  const activation = {
    async acknowledgeStarting() {
      startingCalls += 1;
      return {
        status: startingCalls === 1 ? 'applied' : 'already_starting',
        snapshot: snapshot(),
      };
    },
    async acknowledgeRunning(command) {
      runningCommand = command;
      assert.equal(fixture.record().state, 'started');
      return {
        status: 'applied',
        snapshot: snapshot({
          runStatus: 'running',
          attemptStatus: 'running',
          callbackSequence: command.callbackSequence,
          executorHandle: command.executorHandle,
        }),
      };
    },
    async failStart() { throw new Error('must not fail'); },
  };
  const processor = new WorkerRemoteExecutionInboxProcessor(options(fixture, {
    activation,
    executor: {
      async start(launch) {
        assert.equal(fixture.record().state, 'launching');
        assert.deepEqual(
          launch.environment.map((entry) => entry.name),
          ['PUBLIC_VALUE', 'SECRET_VALUE'],
        );
        assert.equal(launch.logArtifactId, 'log-1');
        assert.equal(launch.output.logArtifactId, launch.logArtifactId);
        launchedToken = launch.completionCallback.token;
        return {
          status: 'started', executorHandle: 'process-1',
          executorStartedAtMs: launch.executorStartedAtMs,
        };
      },
    },
  }));
  const result = await processor.process('offer-processor-1');
  assert.equal(result.status, 'running');
  assert.deepEqual(fixture.states, [
    'starting_acknowledged',
    'launching',
    'started',
    'running_acknowledged',
  ]);
  assert.equal(startingCalls, 2);
  assert.equal(runningCommand.callbackSequence, 1);
  assert.match(runningCommand.callbackTokenDigest, /^[a-f0-9]{64}$/);
  assert.ok([...launchedToken].every((value) => value === 0));
});

test('passes timeout to the Executor only with durable starting deadline authority', async () => {
  const fixture = inboxFixture(
    createWorkerRemoteExecutionInboxRecord(offer(5_000), 100),
  );
  let launch;
  const base = options(fixture, {
    activation: {
      async acknowledgeStarting() {
        return {
          status: 'already_starting',
          snapshot: snapshot({ deadlineAtMs: 6_000 }),
        };
      },
      async acknowledgeRunning(command) {
        return {
          status: 'applied',
          snapshot: snapshot({
            runStatus: 'running', attemptStatus: 'running',
            callbackSequence: command.callbackSequence,
            executorHandle: command.executorHandle,
            deadlineAtMs: 6_000,
          }),
        };
      },
      async failStart() { throw new Error('must not fail'); },
    },
    executor: {
      async start(value) {
        launch = value;
        return {
          status: 'started', executorHandle: 'process-1',
          executorStartedAtMs: value.executorStartedAtMs,
        };
      },
    },
  });
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'running');
  assert.equal(launch.timeoutMs, 5_000);
  assert.equal(launch.executionDeadlineAtMs, 6_000);
});

test('fails closed before spawn when timeout revision lacks durable deadline authority', async () => {
  const fixture = inboxFixture(
    createWorkerRemoteExecutionInboxRecord(offer(5_000), 100),
  );
  let starts = 0;
  const base = options(fixture, {
    executor: { async start() { starts += 1; return { status: 'rejected' }; } },
  });
  await assert.rejects(
    new WorkerRemoteExecutionInboxProcessor(base).process('offer-processor-1'),
    /activation_response_invalid/,
  );
  assert.equal(starts, 0);
});

test('treats an ambiguous executor error as recovery, never start failure', async () => {
  const fixture = inboxFixture();
  let failCalls = 0;
  let closes = 0;
  const base = options(fixture, {
    materializer: {
      async prepare() {
        return {
          environment: [
            { name: 'SECRET_VALUE', value: 'resolved-secret' },
            { name: 'PUBLIC_VALUE', value: 'visible' },
          ],
          logArtifactId: 'log-1',
          takeOutput: () => outputSink('log-1', () => { closes += 1; }),
        };
      },
    },
    executor: { async start() { throw new Error('response lost after spawn'); } },
  });
  base.activation.failStart = async () => {
    failCalls += 1;
    throw new Error('must not be called');
  };
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.recoveryReason, 'launch_outcome_unknown');
  assert.equal(failCalls, 0);
  assert.equal(closes, 0);
  assert.equal(fixture.record().state, 'recovery_required');
});

test('reports only an explicit no-spawn rejection as start failure', async () => {
  const fixture = inboxFixture();
  let failureCommand;
  let closes = 0;
  const base = options(fixture, {
    materializer: {
      async prepare() {
        return {
          environment: [
            { name: 'SECRET_VALUE', value: 'resolved-secret' },
            { name: 'PUBLIC_VALUE', value: 'visible' },
          ],
          logArtifactId: 'log-1',
          takeOutput: () => outputSink('log-1', () => { closes += 1; }),
        };
      },
    },
    executor: { async start() { return { status: 'rejected' }; } },
  });
  base.activation.failStart = async (command) => {
    failureCommand = command;
    return {
      status: 'applied',
      snapshot: snapshot({
        runStatus: 'failed',
        attemptStatus: 'failed',
        leaseVersion: 1,
        callbackSequence: 1,
      }),
    };
  };
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'start_failed');
  assert.equal(failureCommand.offerId, 'offer-processor-1');
  assert.equal(closes, 1);
  assert.equal(fixture.record().state, 'start_failure_acknowledged');
});

test('takes output only after the durable launching barrier', async () => {
  const fixture = inboxFixture();
  let starts = 0;
  const base = options(fixture, {
    materializer: {
      async prepare() {
        return {
          environment: [
            { name: 'SECRET_VALUE', value: 'resolved-secret' },
            { name: 'PUBLIC_VALUE', value: 'visible' },
          ],
          logArtifactId: 'log-1',
          takeOutput() {
            assert.equal(fixture.record().state, 'launching');
            return outputSink();
          },
        };
      },
    },
    executor: {
      async start(launch) {
        starts += 1;
        return {
          status: 'started', executorHandle: 'process-1',
          executorStartedAtMs: launch.executorStartedAtMs,
        };
      },
    },
  });
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'running');
  assert.equal(starts, 1);
});

test('fails without spawning when the handed-off output identity drifts', async () => {
  const fixture = inboxFixture();
  let starts = 0;
  let closes = 0;
  const base = options(fixture, {
    materializer: {
      async prepare() {
        return {
          environment: [
            { name: 'SECRET_VALUE', value: 'resolved-secret' },
            { name: 'PUBLIC_VALUE', value: 'visible' },
          ],
          logArtifactId: 'log-1',
          takeOutput: () => outputSink('different-log', () => { closes += 1; }),
        };
      },
    },
    executor: {
      async start() {
        starts += 1;
        return {
          status: 'started', executorHandle: 'process-1', executorStartedAtMs: 900,
        };
      },
    },
  });
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'start_failed');
  assert.equal(starts, 0);
  assert.equal(closes, 1);
});

test('never respawns a restart-visible launching record', async () => {
  const accepted = createWorkerRemoteExecutionInboxRecord(offer(), 100);
  const starting = {
    ...accepted,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: 101,
  };
  assertWorkerRemoteExecutionInboxTransition(accepted, starting);
  const launching = {
    ...starting,
    revision: 2,
    state: 'launching',
    updatedAtMs: 102,
    executorStartedAtMs: 102,
    logArtifactId: 'log-1',
    completionReceiptCallbackSequence: 1,
    completionReceiptTokenDigest: 'b'.repeat(64),
  };
  assertWorkerRemoteExecutionInboxTransition(starting, launching);
  const fixture = inboxFixture(launching);
  let sideEffects = 0;
  const base = options(fixture);
  base.activation.acknowledgeStarting = async () => { sideEffects += 1; };
  base.executor.start = async () => { sideEffects += 1; };
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'recovery_required');
  assert.equal(sideEffects, 0);
  assert.equal(fixture.record().state, 'recovery_required');
});

test('revalidates the exact durable log and callback barrier before POSIX spawn', async () => {
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
    executorStartedAtMs: 102,
    logArtifactId: 'log-1',
    completionReceiptCallbackSequence: 1,
    completionReceiptTokenDigest: 'b'.repeat(64),
  };
  assertWorkerRemoteExecutionInboxTransition(accepted, starting);
  assertWorkerRemoteExecutionInboxTransition(starting, launching);
  const barrier = new WorkerInboxExecutionSpawnBarrier({
    async readOffer() { return launching; },
  });
  const exact = {
    offerId: 'offer-processor-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    callbackSequence: 1,
    callbackTokenDigest: 'b'.repeat(64),
    logArtifactId: 'log-1',
    executorStartedAtMs: 102,
  };
  await barrier.verify(exact);
  await assert.rejects(
    barrier.verify({ ...exact, logArtifactId: 'log-2' }),
    /authority drifted/,
  );
  await assert.rejects(
    barrier.verify({ ...exact, callbackTokenDigest: 'c'.repeat(64) }),
    /authority drifted/,
  );
});

test('reports failure before the spawn barrier when materialized public data drifts', async () => {
  const fixture = inboxFixture();
  let starts = 0;
  const base = options(fixture, {
    materializer: {
      async prepare() {
        return {
          environment: [
            { name: 'PUBLIC_VALUE', value: 'tampered' },
            { name: 'SECRET_VALUE', value: 'resolved-secret' },
          ],
        };
      },
    },
    executor: {
      async start() {
        starts += 1;
        return { status: 'started', executorHandle: 'x', executorStartedAtMs: 900 };
      },
    },
  });
  const result = await new WorkerRemoteExecutionInboxProcessor(base)
    .process('offer-processor-1');
  assert.equal(result.status, 'start_failed');
  assert.equal(starts, 0);
  assert.equal(fixture.record().state, 'start_failure_acknowledged');
});
