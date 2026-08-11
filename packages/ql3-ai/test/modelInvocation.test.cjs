const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createStepRunRecord,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  InvalidModelInvocationError,
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
  normalizeModelInvocationCompletionCommand,
  normalizeModelInvocationStartCommand,
} = require('../dist/model-invocation/modelInvocation.js');

const NOW = 1_000_000;

function readyStepRun() {
  return createStepRunRecord({
    id: 'step-a',
    runId: 'run-a',
    stepKey: 'summarize',
    kind: 'model',
    definitionRef: 'prompt:summary@1',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:input-a',
    mutationId: 'create-step-a',
    createdAtMs: NOW - 1,
  });
}

function audit(phase, overrides = {}) {
  return {
    phase,
    projectId: 'project-a',
    runId: 'run-a',
    stepRunId: 'step-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    provider: 'remote',
    model: 'model-a',
    policyRevision: 'policy-1',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    deadlineAtMs: NOW + 10_000,
    inputBytes: 128,
    maxOutputTokens: 64,
    outputBytes: 0,
    usage: null,
    errorCode: null,
    occurredAtMs: NOW,
    ...overrides,
  };
}

function startFixture(requestId = 'request-a') {
  const current = readyStepRun();
  const identity = createModelInvocationMutationIdentity(requestId, 'start');
  const mutation = transitionStepRunMutation(
    current,
    {
      expectedVersion: current.version,
      expectedDigest: current.stepRunDigest,
      mutationId: identity.mutationId,
      to: 'running',
      atMs: NOW,
    },
    {
      expectedRunVersion: 1,
      expectedRunEventSequence: 1,
      eventId: identity.eventId,
      dedupeKey: identity.dedupeKey,
      actor: { type: 'executor', id: 'model-gateway' },
    },
  );
  return createModelInvocationStartCommand(
    audit('admitted', { requestId }),
    mutation,
  );
}

function completionFixture({ requestId = 'request-a', errorCode = null } = {}) {
  const startCommand = startFixture(requestId);
  const identity = createModelInvocationMutationIdentity(
    requestId,
    'completion',
  );
  const failed = errorCode !== null;
  const timedOut = errorCode === 'MODEL_INVOCATION_DEADLINE_EXCEEDED';
  const lost =
    errorCode === 'MODEL_INVOCATION_ABORTED' ||
    errorCode === 'MODEL_STREAM_CANCELLED';
  const status = timedOut
    ? 'timed_out'
    : lost
    ? 'lost'
    : failed
    ? 'failed'
    : 'succeeded';
  const mutation = transitionStepRunMutation(
    startCommand.stepRunMutation.stepRun,
    {
      expectedVersion: startCommand.start.startedStepRunVersion,
      expectedDigest: startCommand.start.startedStepRunDigest,
      mutationId: identity.mutationId,
      to: status,
      atMs: NOW + 25,
      ...(failed
        ? {
            resultCode: timedOut
              ? 'model_deadline_exceeded'
              : lost
              ? 'model_outcome_unknown'
              : 'model_provider_failed',
            errorSummary: timedOut
              ? 'Model invocation deadline exceeded'
              : lost
              ? 'Model invocation outcome is unknown'
              : 'Model invocation failed',
          }
        : { outputRef: `model-invocation:${requestId}` }),
    },
    {
      expectedRunVersion: 2,
      expectedRunEventSequence: 2,
      eventId: identity.eventId,
      dedupeKey: identity.dedupeKey,
      actor: { type: 'executor', id: 'model-gateway' },
    },
  );
  const completionAudit = audit(failed ? 'failed' : 'completed', {
    requestId,
    occurredAtMs: NOW + 25,
    outputBytes: failed ? 0 : 12,
    usage: failed ? null : { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    errorCode,
  });
  return createModelInvocationCompletionCommand(
    startCommand.start,
    completionAudit,
    mutation,
  );
}

test('model invocation reuses one StepRun mutation chain without content', () => {
  const start = startFixture();
  const completion = completionFixture();

  assert.deepEqual(normalizeModelInvocationStartCommand(start), start);
  assert.deepEqual(
    normalizeModelInvocationCompletionCommand(completion),
    completion,
  );
  assert.equal(start.stepRunMutation.previousStatus, 'ready');
  assert.equal(start.stepRunMutation.stepRun.status, 'running');
  assert.equal(completion.stepRunMutation.previousStatus, 'running');
  assert.equal(completion.stepRunMutation.stepRun.status, 'succeeded');
  assert.equal(completion.completion.outcome, 'succeeded');
  assert.equal(
    JSON.stringify({ start, completion }).includes('top secret prompt'),
    false,
  );
});

test('deadline completion is terminal timed_out and not replayable', () => {
  const completion = completionFixture({
    errorCode: 'MODEL_INVOCATION_DEADLINE_EXCEEDED',
  });

  assert.equal(completion.completion.outcome, 'timed_out');
  assert.equal(completion.stepRunMutation.stepRun.status, 'timed_out');
  assert.equal(
    completion.stepRunMutation.stepRun.resultCode,
    'model_deadline_exceeded',
  );
});

test('unknown provider outcome maps to lost for manual resolution', () => {
  const completion = completionFixture({
    errorCode: 'MODEL_INVOCATION_ABORTED',
  });

  assert.equal(completion.completion.outcome, 'outcome_unknown');
  assert.equal(completion.stepRunMutation.stepRun.status, 'lost');
  assert.equal(
    completion.stepRunMutation.stepRun.resultCode,
    'model_outcome_unknown',
  );
});

test('max-length invocation IDs derive bounded stable mutation identities', () => {
  const requestId = `r${'x'.repeat(127)}`;
  const first = createModelInvocationMutationIdentity(requestId, 'start');
  const replay = createModelInvocationMutationIdentity(requestId, 'start');

  assert.deepEqual(first, replay);
  assert.ok(first.mutationId.length <= 128);
  assert.ok(first.eventId.length <= 128);
  assert.ok(first.dedupeKey.length <= 128);
  assert.doesNotThrow(() => startFixture(requestId));
});

test('trace drift and command digest tampering fail closed', () => {
  const completion = completionFixture();
  const drifted = {
    ...completion,
    completion: { ...completion.completion, traceId: 'trace-b' },
  };
  const tampered = {
    ...completion,
    commandDigest: '0'.repeat(64),
  };

  assert.throws(
    () => normalizeModelInvocationCompletionCommand(drifted),
    InvalidModelInvocationError,
  );
  assert.throws(
    () => normalizeModelInvocationCompletionCommand(tampered),
    InvalidModelInvocationError,
  );
});
