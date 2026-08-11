'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidPluginPackageWorkflowCancellationConvergenceError,
  resolvePluginPackageWorkflowCancellation,
} = require('@qinglong/runtime-core/plugin-package-workflow-cancellation-convergence');
const {
  pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest,
} = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
const {
  createStepRunRecord,
  transitionStepRunRecord,
} = require('@qinglong/runtime-core/step-run');

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
    cancelRequestedAtMs: 800,
    cancelReason: 'user',
    ...overrides,
  };
}

function step(id, stepKey, initialStatus = 'ready', createdAtMs = 300) {
  return createStepRunRecord({
    id,
    runId: 'workflow-run-1',
    stepKey,
    kind: 'task',
    definitionRef: `pkg:demo:${stepKey}`,
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus,
    mutationId: `create-${stepKey}`,
    createdAtMs,
  });
}

function attempt(stepRun, overrides = {}) {
  return {
    id: `attempt-${stepRun.stepKey}`,
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

function admission(stepRun, currentAttempt, overrides = {}) {
  const unsigned = {
    schema:
      'qinglong/plugin-package-workflow-task-attempt-admission@v1',
    attemptId: currentAttempt.id,
    planDigest: 'c'.repeat(64),
    runId: 'workflow-run-1',
    stepRunId: stepRun.id,
    stepRunVersion: stepRun.version,
    stepRunDigest: stepRun.stepRunDigest,
    resourceTaskId: stepRun.stepKey,
    taskReconciliationReceiptDigest: 'd'.repeat(64),
    taskId: `pkg:demo:${stepRun.stepKey}`,
    taskRevision: `qltd:v1:1:${'a'.repeat(64)}`,
    taskDefinitionDigest: 'a'.repeat(64),
    executorType: 'remote_worker',
    executionDigest: 'e'.repeat(64),
    attemptNumber: 1,
    eventId: `admit-${stepRun.stepKey}`,
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

function active(stepRun, currentAttempt, leaseStatus) {
  return {
    admission: admission(stepRun, currentAttempt),
    attempt: currentAttempt,
    leaseStatus,
  };
}

test('cancels every non-executing StepRun and terminalizes the Workflow', () => {
  const pending = step('step-prepare', 'prepare', 'pending');
  const ready = step('step-execute', 'execute');
  const resolution = resolvePluginPackageWorkflowCancellation({
    run: run(),
    stepRuns: [ready, pending],
    activeTaskAttempts: [],
    observedAtMs: 1_000,
  });

  assert.deepEqual(
    resolution.stepMutations.map(({ stepRun }) => [
      stepRun.stepKey,
      stepRun.status,
    ]),
    [
      ['execute', 'cancelled'],
      ['prepare', 'cancelled'],
    ],
  );
  assert.equal(resolution.attemptTransitions.length, 0);
  assert.deepEqual(resolution.blockedStepRunIds, []);
  assert.equal(resolution.terminalTransition.status, 'cancelled');
  assert.equal(resolution.terminalTransition.event.type, 'workflow.cancelled');
  assert.equal(resolution.run.status, 'cancelled');
  assert.equal(resolution.run.version, 8);
  assert.equal(resolution.run.eventSequence, 8);
});

test('settles an unleased claimed Task before cancelling its exact StepRun', () => {
  const ready = step('step-execute', 'execute');
  const claimed = attempt(ready);
  const resolution = resolvePluginPackageWorkflowCancellation({
    run: run(),
    stepRuns: [ready],
    activeTaskAttempts: [active(ready, claimed, null)],
    observedAtMs: 1_000,
  });

  assert.equal(resolution.attemptTransitions.length, 1);
  assert.equal(resolution.attemptTransitions[0].previousStatus, 'claimed');
  assert.equal(resolution.attemptTransitions[0].attempt.status, 'cancelled');
  assert.equal(
    resolution.attemptTransitions[0].event.type,
    'workflow.task_attempt.cancelled',
  );
  assert.equal(resolution.attemptTransitions[0].event.sequence, 6);
  assert.equal(resolution.stepMutations[0].event.sequence, 7);
  assert.equal(resolution.terminalTransition.event.sequence, 8);
  assert.equal(resolution.run.status, 'cancelled');
});

test('cancels idle siblings but blocks on leased and running authority', () => {
  const leasedStep = step('step-leased', 'leased');
  const leasedAttempt = attempt(leasedStep);
  const admittedRunningStep = step('step-running', 'running');
  const runningStep = transitionStepRunRecord(admittedRunningStep, {
    expectedVersion: admittedRunningStep.version,
    expectedDigest: admittedRunningStep.stepRunDigest,
    mutationId: 'start-running',
    to: 'running',
    atMs: 500,
  });
  const runningAttempt = attempt(admittedRunningStep, {
    id: 'attempt-running',
    status: 'running',
    startedAtMs: 500,
  });
  const idle = step('step-idle', 'idle', 'pending');
  const resolution = resolvePluginPackageWorkflowCancellation({
    run: run(),
    stepRuns: [runningStep, idle, leasedStep],
    activeTaskAttempts: [
      active(leasedStep, leasedAttempt, 'leased'),
      active(admittedRunningStep, runningAttempt, 'leased'),
    ],
    observedAtMs: 1_000,
  });

  assert.deepEqual(
    resolution.blockedAttemptIds,
    ['attempt-leased', 'attempt-running'],
  );
  assert.deepEqual(
    resolution.blockedStepRunIds,
    ['step-leased', 'step-running'],
  );
  assert.deepEqual(
    resolution.stepMutations.map(({ stepRun }) => stepRun.stepKey),
    ['idle'],
  );
  assert.equal(resolution.terminalTransition, null);
  assert.equal(resolution.run.status, 'running');
  assert.equal(resolution.run.version, 6);
});

test('maps aggregate timeout without pretending a pending Step timed out', () => {
  const pending = step('step-pending', 'pending', 'pending');
  const ready = step('step-ready', 'ready');
  const claimed = attempt(ready);
  const resolution = resolvePluginPackageWorkflowCancellation({
    run: run({ cancelReason: 'timeout' }),
    stepRuns: [ready, pending],
    activeTaskAttempts: [active(ready, claimed, 'released')],
    observedAtMs: 1_000,
  });

  assert.equal(resolution.attemptTransitions[0].attempt.status, 'timed_out');
  assert.deepEqual(
    resolution.stepMutations.map(({ stepRun }) => [
      stepRun.stepKey,
      stepRun.status,
    ]),
    [
      ['pending', 'cancelled'],
      ['ready', 'timed_out'],
    ],
  );
  assert.equal(resolution.run.status, 'timed_out');
  assert.equal(resolution.run.errorCode, 'EXECUTION_TIMED_OUT');
});

test('is deterministic and fails closed on stale admission authority', () => {
  const ready = step('step-execute', 'execute');
  const claimed = attempt(ready);
  const input = {
    run: run(),
    stepRuns: [ready],
    activeTaskAttempts: [active(ready, claimed, null)],
    observedAtMs: 1_000,
  };
  assert.deepEqual(
    resolvePluginPackageWorkflowCancellation(input),
    resolvePluginPackageWorkflowCancellation(input),
  );
  const refreshed = transitionStepRunRecord(ready, {
    expectedVersion: ready.version,
    expectedDigest: ready.stepRunDigest,
    mutationId: 'refresh-ready',
    to: 'ready',
    atMs: 700,
  });
  assert.throws(
    () =>
      resolvePluginPackageWorkflowCancellation({
        ...input,
        stepRuns: [refreshed],
      }),
    InvalidPluginPackageWorkflowCancellationConvergenceError,
  );
});
