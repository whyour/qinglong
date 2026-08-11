const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlRecoveryFenceLostError,
  EvidenceBasedClusterControlRecoveryProcessor,
  InvalidClusterControlRecoveryTransitionError,
  buildClusterControlRecoveryLostTransition,
} = require('../dist');

function run(overrides = {}) {
  return {
    id: 'run-1',
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'v1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'dispatching',
    version: 1,
    eventSequence: 0,
    priority: 0,
    createdAtMs: 100,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: 'attempt-1',
    runId: 'run-1',
    attempt: 1,
    status: 'claimed',
    executorType: 'worker',
    workerId: 'worker-1',
    leaseToken: 'lease-token',
    leaseExpiresAtMs: 900,
    callbackSequence: 0,
    createdAtMs: 200,
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    candidate: {
      kind: 'attempt',
      id: 'attempt-1',
      runId: 'run-1',
      status: 'claimed',
      createdAtMs: 200,
    },
    observedAtMs: 1000,
    ownerId: 'replica-a',
    token: '00000000-0000-4000-8000-000000000001',
    version: 1,
    expiresAtMs: 31000,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    observedAtMs: 1000,
    run: run(),
    attempt: attempt(),
    ...overrides,
  };
}

test('builds an Attempt-lost then Run-lost aggregate without creating work', () => {
  const transition = buildClusterControlRecoveryLostTransition(
    run(),
    attempt(),
    {
      kind: 'mark_attempt_and_run_lost',
      reason: 'unstarted_claim_expired',
    },
    1000,
  );

  assert.equal(transition.attempt.attempt.status, 'lost');
  assert.equal(transition.attempt.attempt.finishedAtMs, 1000);
  assert.equal(
    transition.attempt.attempt.errorCode,
    'CLUSTER_RECOVERY_UNSTARTED_CLAIM_EXPIRED',
  );
  assert.equal(transition.attempt.run.version, 2);
  assert.equal(transition.attempt.event.type, 'attempt.lost');
  assert.equal(transition.run.run.status, 'lost');
  assert.equal(transition.run.run.version, 3);
  assert.equal(transition.run.run.eventSequence, 2);
  assert.equal(transition.run.event.type, 'run.lost');
  assert.equal('finishedAtMs' in transition.run.run, false);
});

test('supports Run-only and Attempt-only convergence but rejects widened authority', () => {
  const runOnly = buildClusterControlRecoveryLostTransition(
    run({ status: 'running' }),
    attempt({ status: 'lost', finishedAtMs: 900 }),
    { kind: 'mark_run_lost', reason: 'attempt_already_lost' },
    1000,
  );
  assert.equal(runOnly.attempt, undefined);
  assert.equal(runOnly.run.run.status, 'lost');

  const attemptOnly = buildClusterControlRecoveryLostTransition(
    run({ status: 'lost' }),
    attempt({ status: 'running', startedAtMs: 300 }),
    { kind: 'mark_attempt_lost', reason: 'execution_not_running' },
    1000,
  );
  assert.equal(attemptOnly.run, undefined);
  assert.equal(attemptOnly.attempt.attempt.status, 'lost');

  assert.throws(
    () =>
      buildClusterControlRecoveryLostTransition(
        run({ cancelRequestedAtMs: 800, cancelReason: 'user' }),
        attempt(),
        {
          kind: 'mark_attempt_and_run_lost',
          reason: 'unstarted_claim_expired',
        },
        1000,
      ),
    InvalidClusterControlRecoveryTransitionError,
  );
  assert.throws(
    () =>
      buildClusterControlRecoveryLostTransition(
        run({ executionOwner: 'legacy' }),
        attempt(),
        {
          kind: 'mark_attempt_and_run_lost',
          reason: 'unstarted_claim_expired',
        },
        1000,
      ),
    InvalidClusterControlRecoveryTransitionError,
  );
});

test('marks an expired unstarted claim lost without consulting external evidence', async () => {
  const calls = [];
  const processor = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        calls.push('load');
        return snapshot();
      },
      async applyLost(_claim, _snapshot, action) {
        calls.push(action);
        return 'applied';
      },
    },
    {
      async inspect() {
        throw new Error('unstarted work must not be probed');
      },
    },
  );

  assert.deepEqual(await processor.process(claim()), { status: 'resolved' });
  assert.deepEqual(calls, [
    'load',
    {
      kind: 'mark_attempt_and_run_lost',
      reason: 'unstarted_claim_expired',
    },
  ]);
});

test('routes an admission-bound Workflow Task to its dedicated recovery action', async () => {
  const actions = [];
  const processor = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        return snapshot({
          run: run({
            triggerType: 'plugin_package_workflow',
            executionOrigin: 'system',
            status: 'running',
          }),
          attempt: attempt({ stepRunId: 'step-1' }),
          workflowTask: {
            admission: {
              attemptId: 'attempt-1',
              runId: 'run-1',
              stepRunId: 'step-1',
            },
            stepRun: {
              id: 'step-1',
              runId: 'run-1',
            },
          },
        });
      },
      async applyLost(_claim, _snapshot, action) {
        actions.push(action);
        return 'applied';
      },
    },
    {
      async inspect() {
        throw new Error('unstarted work must not be probed');
      },
    },
  );

  assert.deepEqual(await processor.process(claim()), { status: 'resolved' });
  assert.deepEqual(actions, [
    {
      kind: 'recover_workflow_task',
      reason: 'unstarted_claim_expired',
    },
  ]);
});

test('requires trusted absence evidence after the start barrier', async () => {
  const actions = [];
  const evidence = [];
  const processor = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        return snapshot({
          attempt: attempt({ status: 'running', startedAtMs: 300 }),
        });
      },
      async applyLost(_claim, _snapshot, action) {
        actions.push(action);
        return 'applied';
      },
    },
    {
      async inspect(_claim, target) {
        evidence.push(target);
        return { status: 'not_running' };
      },
    },
  );

  assert.deepEqual(await processor.process(claim()), { status: 'resolved' });
  assert.equal(evidence[0].attemptId, 'attempt-1');
  assert.equal(evidence[0].attemptStatus, 'running');
  assert.deepEqual(actions, [
    {
      kind: 'mark_attempt_and_run_lost',
      reason: 'execution_not_running',
    },
  ]);
});

test('keeps running and unavailable evidence retryable, and ambiguity manual', async () => {
  const values = [
    { status: 'running' },
    { status: 'unknown', reason: 'provider_unavailable' },
    { status: 'unknown', reason: 'identity_unverifiable' },
  ];
  const processor = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        return snapshot({
          attempt: attempt({ status: 'starting', startedAtMs: 300 }),
        });
      },
      async applyLost() {
        throw new Error('uncertain evidence must not mutate');
      },
    },
    {
      async inspect() {
        return values.shift();
      },
    },
    { retryDelayMs: 2500 },
  );

  assert.deepEqual(await processor.process(claim()), {
    status: 'retry',
    delayMs: 2500,
  });
  assert.deepEqual(await processor.process(claim()), {
    status: 'retry',
    delayMs: 2500,
  });
  assert.deepEqual(await processor.process(claim()), { status: 'manual' });
});

test('resolves restored ownership and stale state without mutation', async () => {
  const snapshots = [
    snapshot({
      attempt: attempt({ leaseExpiresAtMs: 5000 }),
    }),
    snapshot({
      run: run({ status: 'lost' }),
      attempt: attempt({ status: 'lost', finishedAtMs: 900 }),
    }),
  ];
  let applies = 0;
  const processor = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        return snapshots.shift();
      },
      async applyLost() {
        applies += 1;
        return 'applied';
      },
    },
    {
      async inspect() {
        throw new Error('not expected');
      },
    },
  );

  assert.deepEqual(await processor.process(claim()), { status: 'resolved' });
  assert.deepEqual(await processor.process(claim()), { status: 'resolved' });
  assert.equal(applies, 0);
});

test('surfaces a lost claim fence and treats a CAS-stale snapshot as resolved', async () => {
  const fencedLoad = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        return 'fenced';
      },
      async applyLost() {
        throw new Error('not expected');
      },
    },
    {
      async inspect() {
        throw new Error('not expected');
      },
    },
  );
  await assert.rejects(
    fencedLoad.process(claim()),
    ClusterControlRecoveryFenceLostError,
  );

  const staleApply = new EvidenceBasedClusterControlRecoveryProcessor(
    {
      async load() {
        return snapshot();
      },
      async applyLost() {
        return 'stale';
      },
    },
    {
      async inspect() {
        throw new Error('not expected');
      },
    },
  );
  assert.deepEqual(await staleApply.process(claim()), { status: 'resolved' });
});
