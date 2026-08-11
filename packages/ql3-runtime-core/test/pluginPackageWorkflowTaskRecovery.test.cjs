const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidPluginPackageWorkflowTaskRecoveryError,
  buildPluginPackageWorkflowTaskRecovery,
} = require('../dist');
const {
  pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest,
} = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
const {
  createStepRunRecord,
  transitionStepRunRecord,
} = require('../dist/run/stepRun');

function run(overrides = {}) {
  return {
    id: 'workflow-run-1',
    projectId: 'default',
    taskId: 'workflow-alpha',
    taskRevision: 'b'.repeat(64),
    triggerType: 'plugin_package_workflow',
    executionOrigin: 'system',
    executionOwner: 'runtime',
    requestId: 'workflow-plan-1',
    idempotencyKey: 'plugin-package-workflow:workflow-plan-1',
    status: 'running',
    version: 5,
    eventSequence: 5,
    priority: 0,
    createdAtMs: 100,
    startedAtMs: 200,
    ...overrides,
  };
}

function readyStep() {
  return createStepRunRecord({
    id: 'workflow-step-1',
    runId: 'workflow-run-1',
    stepKey: 'collect',
    kind: 'task',
    definitionRef: 'pkg:demo:alpha',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    mutationId: 'workflow-step-created',
    createdAtMs: 300,
  });
}

function attempt(stepRun, overrides = {}) {
  return {
    id: 'workflow-attempt-1',
    runId: 'workflow-run-1',
    stepRunId: stepRun.id,
    attempt: 1,
    status: 'claimed',
    executorType: 'remote_worker',
    callbackSequence: 0,
    createdAtMs: 400,
    leaseExpiresAtMs: 900,
    ...overrides,
  };
}

function admission(stepRun, overrides = {}) {
  const unsigned = {
    schema:
      'qinglong/plugin-package-workflow-task-attempt-admission@v1',
    attemptId: 'workflow-attempt-1',
    planDigest: 'c'.repeat(64),
    runId: 'workflow-run-1',
    stepRunId: stepRun.id,
    stepRunVersion: stepRun.version,
    stepRunDigest: stepRun.stepRunDigest,
    resourceTaskId: 'alpha',
    taskReconciliationReceiptDigest: 'd'.repeat(64),
    taskId: 'pkg:demo:alpha',
    taskRevision: `qltd:v1:1:${'a'.repeat(64)}`,
    taskDefinitionDigest: 'a'.repeat(64),
    executorType: 'remote_worker',
    executionDigest: 'e'.repeat(64),
    attemptNumber: 1,
    eventId: 'workflow-attempt-admitted',
    runVersion: 3,
    runEventSequence: 3,
    admittedAtMs: 400,
    ...overrides,
  };
  return {
    ...unsigned,
    receiptDigest:
      pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest(unsigned),
  };
}

test('loses only the expired Attempt and refreshes the exact ready epoch', () => {
  const stepRun = readyStep();
  const result = buildPluginPackageWorkflowTaskRecovery({
    admission: admission(stepRun),
    run: run(),
    attempt: attempt(stepRun),
    stepRun,
    reason: 'unstarted_claim_expired',
    observedAtMs: 1_000,
  });

  assert.equal(result.disposition, 'requeued');
  assert.equal(result.attempt.status, 'lost');
  assert.equal(
    result.attempt.errorCode,
    'CLUSTER_RECOVERY_UNSTARTED_CLAIM_EXPIRED',
  );
  assert.equal(result.attemptEvent.sequence, 6);
  assert.equal(result.attemptEvent.stepRunId, stepRun.id);
  assert.equal(result.run.status, 'running');
  assert.equal(result.run.version, 7);
  assert.equal(result.run.eventSequence, 7);
  assert.equal(result.stepMutations.length, 1);
  const refresh = result.stepMutations[0];
  assert.equal(refresh.previousStatus, 'ready');
  assert.equal(refresh.stepRun.status, 'ready');
  assert.equal(refresh.stepRun.version, stepRun.version + 1);
  assert.equal(refresh.stepRun.attemptCount, 0);
  assert.equal(refresh.stepRun.readyAtMs, stepRun.readyAtMs);
  assert.equal(refresh.stepRun.startedAtMs, null);
  assert.notEqual(refresh.stepRun.stepRunDigest, stepRun.stepRunDigest);
  assert.equal(refresh.event.sequence, 7);
});

test('fails a starting Attempt without pretending that the StepRun ran', () => {
  const stepRun = readyStep();
  const currentAttempt = attempt(stepRun, {
    status: 'starting',
    callbackSequence: 1,
  });
  const result = buildPluginPackageWorkflowTaskRecovery({
    admission: admission(stepRun),
    run: run(),
    attempt: currentAttempt,
    stepRun,
    reason: 'execution_not_running',
    observedAtMs: 1_000,
  });

  assert.equal(result.disposition, 'failed');
  assert.equal(result.run.status, 'running');
  assert.equal(result.run.version, 7);
  assert.equal(result.attempt.status, 'lost');
  assert.equal(result.stepMutations.length, 1);
  const failed = result.stepMutations[0].stepRun;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attemptCount, 0);
  assert.equal(failed.startedAtMs, null);
  assert.equal(failed.finishedAtMs, 1_000);
  assert.equal(
    failed.resultCode,
    'cluster_recovery_execution_not_running',
  );
});

test('records running→lost→failed before the Workflow frontier settles', () => {
  const admittedStep = readyStep();
  const runningStep = transitionStepRunRecord(admittedStep, {
    expectedVersion: admittedStep.version,
    expectedDigest: admittedStep.stepRunDigest,
    mutationId: 'workflow-step-running',
    to: 'running',
    atMs: 500,
  });
  const currentAttempt = attempt(admittedStep, {
    status: 'running',
    callbackSequence: 2,
    startedAtMs: 500,
  });
  const result = buildPluginPackageWorkflowTaskRecovery({
    admission: admission(admittedStep),
    run: run({ version: 6, eventSequence: 6 }),
    attempt: currentAttempt,
    stepRun: runningStep,
    reason: 'execution_not_running',
    observedAtMs: 1_000,
  });

  assert.equal(result.run.status, 'running');
  assert.equal(result.run.version, 9);
  assert.deepEqual(
    result.stepMutations.map(({ previousStatus, stepRun }) => [
      previousStatus,
      stepRun.status,
    ]),
    [
      ['running', 'lost'],
      ['lost', 'failed'],
    ],
  );
  assert.deepEqual(
    result.stepMutations.map(({ event }) => event.sequence),
    [8, 9],
  );
  assert.equal(result.stepMutations[1].stepRun.startedAtMs, 500);
  assert.equal(result.stepMutations[1].stepRun.finishedAtMs, 1_000);
});

test('is deterministic for a durable recovery observation', () => {
  const stepRun = readyStep();
  const input = {
    admission: admission(stepRun),
    run: run(),
    attempt: attempt(stepRun),
    stepRun,
    reason: 'unstarted_claim_expired',
    observedAtMs: 1_000,
  };
  assert.deepEqual(
    buildPluginPackageWorkflowTaskRecovery(input),
    buildPluginPackageWorkflowTaskRecovery(input),
  );
});

test('fails closed on cancellation, stale epochs and unsafe reason widening', () => {
  const stepRun = readyStep();
  const base = {
    admission: admission(stepRun),
    run: run(),
    attempt: attempt(stepRun),
    stepRun,
    reason: 'unstarted_claim_expired',
    observedAtMs: 1_000,
  };
  assert.throws(
    () =>
      buildPluginPackageWorkflowTaskRecovery({
        ...base,
        run: run({
          cancelRequestedAtMs: 900,
          cancelReason: 'user',
        }),
      }),
    InvalidPluginPackageWorkflowTaskRecoveryError,
  );
  assert.throws(
    () =>
      buildPluginPackageWorkflowTaskRecovery({
        ...base,
        stepRun: transitionStepRunRecord(stepRun, {
          expectedVersion: stepRun.version,
          expectedDigest: stepRun.stepRunDigest,
          mutationId: 'stale-epoch',
          to: 'ready',
          atMs: 800,
        }),
      }),
    InvalidPluginPackageWorkflowTaskRecoveryError,
  );
  assert.throws(
    () =>
      buildPluginPackageWorkflowTaskRecovery({
        ...base,
        reason: 'execution_not_running',
      }),
    InvalidPluginPackageWorkflowTaskRecoveryError,
  );
});
