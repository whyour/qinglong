const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  InvalidStepRunError,
  STEP_RUN_MUTATION_SCHEMA,
  STEP_RUN_SCHEMA,
  StepRunFenceConflictError,
  StepRunMutationConflictError,
  StepRunStateConflictError,
  createStepRunMutation,
  createStepRunRecord,
  normalizeListStepRunsQuery,
  normalizeListStepRunsResult,
  normalizeStepRunMutation,
  normalizeStepRunRecord,
  resolveStepRunMutation,
  transitionStepRunMutation,
  transitionStepRunRecord,
} = require('../dist/run/stepRun');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function createInput(overrides = {}) {
  return {
    id: 'step-run-001',
    runId: 'run-001',
    stepKey: 'workflow.fetch',
    kind: 'tool',
    definitionRef: 'tool:demo.compare@1.0.0',
    definitionDigest: DIGEST_A,
    required: true,
    initialStatus: 'pending',
    inputRef: 'artifact:step-input-001',
    mutationId: 'step-create-001',
    createdAtMs: 1_000,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    expectedRunVersion: 4,
    expectedRunEventSequence: 7,
    eventId: 'event-step-001',
    dedupeKey: 'step-create:step-run-001',
    actor: { type: 'agent', id: 'agent-001' },
    ...overrides,
  };
}

function transition(current, to, overrides = {}) {
  return transitionStepRunRecord(current, {
    expectedVersion: current.version,
    expectedDigest: current.stepRunDigest,
    mutationId: `step-${to}-${current.version + 1}`,
    to,
    atMs: current.updatedAtMs + 100,
    ...overrides,
  });
}

test('creates one immutable pending or ready StepRun with a canonical digest', () => {
  const pending = createStepRunRecord(createInput());
  assert.equal(pending.schema, STEP_RUN_SCHEMA);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.version, 1);
  assert.equal(pending.attemptCount, 0);
  assert.equal(pending.readyAtMs, null);
  assert.match(pending.stepRunDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(pending), true);
  assert.deepEqual(normalizeStepRunRecord(pending), pending);

  const ready = createStepRunRecord(
    createInput({
      id: 'step-run-002',
      stepKey: 'workflow.ready',
      initialStatus: 'ready',
    }),
  );
  assert.equal(ready.readyAtMs, ready.createdAtMs);
});

test('moves a Tool Step through approval, running and success', () => {
  const pending = createStepRunRecord(createInput());
  const ready = transition(pending, 'ready');
  const waiting = transition(ready, 'waiting_approval', {
    approvalRequestId: 'approval-step-001',
  });
  const running = transition(waiting, 'running', {
    approvalRequestId: 'approval-step-001',
  });
  const succeeded = transition(running, 'succeeded', {
    outputRef: 'artifact:step-output-001',
  });

  assert.equal(ready.readyAtMs, 1_100);
  assert.equal(waiting.approvalRequestId, 'approval-step-001');
  assert.equal(running.attemptCount, 1);
  assert.equal(running.startedAtMs, 1_300);
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.outputRef, 'artifact:step-output-001');
  assert.equal(succeeded.finishedAtMs, 1_400);
  assert.equal(succeeded.version, 5);
});

test('supports a fenced lost-to-ready retry with a bounded attempt count', () => {
  const ready = createStepRunRecord(
    createInput({ initialStatus: 'ready' }),
  );
  const first = transition(ready, 'running');
  const lost = transition(first, 'lost', {
    resultCode: 'worker_lost',
    errorSummary: 'Worker lease expired',
  });
  const retryReady = transition(lost, 'ready');
  const second = transition(retryReady, 'running');

  assert.equal(lost.finishedAtMs, null);
  assert.equal(lost.resultCode, 'worker_lost');
  assert.equal(retryReady.resultCode, null);
  assert.equal(retryReady.startedAtMs, null);
  assert.equal(second.attemptCount, 2);
});

test('refreshes a pre-start ready epoch without forging execution', () => {
  const ready = createStepRunRecord(
    createInput({ initialStatus: 'ready' }),
  );
  const refreshed = transition(ready, 'ready');

  assert.equal(refreshed.status, 'ready');
  assert.equal(refreshed.version, ready.version + 1);
  assert.notEqual(refreshed.stepRunDigest, ready.stepRunDigest);
  assert.equal(refreshed.readyAtMs, ready.readyAtMs);
  assert.equal(refreshed.startedAtMs, null);
  assert.equal(refreshed.finishedAtMs, null);
  assert.equal(refreshed.attemptCount, 0);
});

test('records a fenced failure before the StepRun crosses its start barrier', () => {
  const ready = createStepRunRecord(
    createInput({ initialStatus: 'ready' }),
  );
  const failed = transition(ready, 'failed', {
    resultCode: 'executor_start_failed',
    errorSummary: 'Executor failed before execution started',
  });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.startedAtMs, null);
  assert.equal(failed.finishedAtMs, ready.updatedAtMs + 100);
  assert.equal(failed.attemptCount, 0);
  assert.equal(failed.resultCode, 'executor_start_failed');
});

test('keeps terminal states immutable and rejects stale fences', () => {
  const ready = createStepRunRecord(
    createInput({ initialStatus: 'ready' }),
  );
  const running = transition(ready, 'running');
  const failed = transition(running, 'failed', {
    resultCode: 'handler_failed',
  });
  assert.throws(() => transition(failed, 'ready'), StepRunStateConflictError);
  assert.throws(
    () =>
      transitionStepRunRecord(ready, {
        expectedVersion: ready.version + 1,
        expectedDigest: ready.stepRunDigest,
        mutationId: 'stale-step',
        to: 'running',
        atMs: 2_000,
      }),
    StepRunFenceConflictError,
  );
});

test('enforces approval, result, output and time shapes', () => {
  const ready = createStepRunRecord(
    createInput({ initialStatus: 'ready' }),
  );
  assert.throws(
    () => transition(ready, 'waiting_approval'),
    /approval shape/,
  );
  assert.throws(
    () => transition(ready, 'timed_out'),
    /result or approval shape/,
  );
  assert.throws(
    () =>
      transition(ready, 'running', {
        outputRef: 'artifact:not-yet',
      }),
    /result or approval shape/,
  );
  assert.throws(
    () =>
      transition(ready, 'running', {
        atMs: ready.updatedAtMs - 1,
      }),
    /precedes/,
  );
});

test('builds one atomic create mutation for Run, StepRun and RunEvent', () => {
  const mutation = createStepRunMutation(createInput(), context());
  assert.equal(mutation.schema, STEP_RUN_MUTATION_SCHEMA);
  assert.equal(mutation.expectedRunVersion, 4);
  assert.equal(mutation.expectedRunEventSequence, 7);
  assert.equal(mutation.expectedStepRunVersion, null);
  assert.equal(mutation.event.sequence, 8);
  assert.equal(mutation.event.type, 'step.created');
  assert.equal(mutation.event.stepRunId, mutation.stepRun.id);
  assert.equal(
    mutation.event.payload.stepRunDigest,
    mutation.stepRun.stepRunDigest,
  );
  assert.match(mutation.mutationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(normalizeStepRunMutation(mutation), mutation);
});

test('binds a transition mutation to both Run and previous StepRun fences', () => {
  const current = createStepRunRecord(createInput());
  const mutation = transitionStepRunMutation(
    current,
    {
      expectedVersion: current.version,
      expectedDigest: current.stepRunDigest,
      mutationId: 'step-ready-002',
      to: 'ready',
      atMs: 1_100,
    },
    context({
      expectedRunVersion: 5,
      expectedRunEventSequence: 8,
      eventId: 'event-step-002',
      dedupeKey: 'step-ready:step-run-001',
    }),
  );
  assert.equal(mutation.previousStatus, 'pending');
  assert.equal(mutation.expectedStepRunVersion, 1);
  assert.equal(mutation.expectedStepRunDigest, current.stepRunDigest);
  assert.equal(mutation.stepRun.version, 2);
  assert.equal(mutation.event.type, 'step.ready');
  assert.equal(mutation.event.sequence, 9);
  assert.equal(resolveStepRunMutation(current, mutation), 'apply');
  assert.equal(
    resolveStepRunMutation(mutation.stepRun, mutation),
    'existing',
  );
});

test('rejects mutation, replay identity, event and record digest tampering', () => {
  const mutation = createStepRunMutation(createInput(), context());
  assert.equal(resolveStepRunMutation(null, mutation), 'apply');
  assert.equal(
    resolveStepRunMutation(mutation.stepRun, mutation),
    'existing',
  );
  const reused = createStepRunMutation(
    createInput({
      id: 'step-run-reused',
      stepKey: 'workflow.reused',
    }),
    context({
      eventId: 'event-step-reused',
      dedupeKey: 'step-create:step-run-reused',
    }),
  );
  assert.throws(
    () => resolveStepRunMutation(mutation.stepRun, reused),
    StepRunMutationConflictError,
  );
  for (const changed of [
    { ...mutation, mutationDigest: DIGEST_B },
    {
      ...mutation,
      event: { ...mutation.event, sequence: mutation.event.sequence + 1 },
    },
    {
      ...mutation,
      stepRun: { ...mutation.stepRun, definitionDigest: DIGEST_B },
    },
  ]) {
    assert.throws(
      () => normalizeStepRunMutation(changed),
      InvalidStepRunError,
    );
  }
});

test('normalizes bounded keyset pagination and rejects false continuation', () => {
  const first = createStepRunRecord(
    createInput({ id: 'step-run-001', stepKey: 'a' }),
  );
  const second = createStepRunRecord(
    createInput({
      id: 'step-run-002',
      stepKey: 'b',
      mutationId: 'step-create-002',
    }),
  );
  const query = normalizeListStepRunsQuery({
    runId: 'run-001',
    limit: 2,
  });
  assert.deepEqual(
    normalizeListStepRunsResult(
      {
        stepRuns: [first, second],
        truncated: true,
        next: { stepKey: 'b', id: 'step-run-002' },
      },
      query,
    ).next,
    { stepKey: 'b', id: 'step-run-002' },
  );
  assert.throws(
    () =>
      normalizeListStepRunsResult(
        {
          stepRuns: [second, first],
          truncated: false,
        },
        query,
      ),
    /ordering/,
  );
  assert.throws(
    () =>
      normalizeListStepRunsResult(
        {
          stepRuns: [first],
          truncated: true,
        },
        query,
      ),
    /continuation/,
  );
});

test('publishes the same StepRun contract through root and subpath without ambient authority', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/step-run');
  assert.equal(root.createStepRunMutation, createStepRunMutation);
  assert.equal(subpath.transitionStepRunRecord, transitionStepRunRecord);
  const source = readFileSync(
    join(__dirname, '..', 'src', 'run', 'stepRun.ts'),
    'utf8',
  );
  for (const authority of [
    'node:child_process',
    'node:fs',
    'node:http',
    'node:net',
    'node:worker_threads',
  ]) {
    assert.equal(source.includes(`from '${authority}'`), false);
  }
});
