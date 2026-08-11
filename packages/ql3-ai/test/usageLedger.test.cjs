const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createStepRunRecord,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
} = require('../dist/model-invocation/modelInvocation.js');
const {
  InvalidModelInvocationUsageLedgerError,
  MAX_MODEL_INVOCATION_USAGE_QUERY_WINDOW_MS,
  MODEL_INVOCATION_USAGE_LEDGER_SCHEMA,
  createModelInvocationUsageLedgerRecord,
  normalizeModelInvocationUsageLedgerQuery,
  normalizeModelInvocationUsageLedgerRecord,
  normalizeModelInvocationUsageLedgerSummaryQuery,
} = require('@qinglong/ai/usage-ledger');

const NOW = 1_000_000;

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

function startFixture(projectId = 'project-a') {
  const current = createStepRunRecord({
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
  const identity = createModelInvocationMutationIdentity('request-a', 'start');
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
    audit('admitted', { projectId }),
    mutation,
  );
}

function completionFixture({
  errorCode = null,
  usage = { inputTokens: 5, outputTokens: 2, totalTokens: 7, costMicros: 11 },
} = {}) {
  const startCommand = startFixture();
  const identity = createModelInvocationMutationIdentity(
    'request-a',
    'completion',
  );
  const failed = errorCode !== null;
  const mutation = transitionStepRunMutation(
    startCommand.stepRunMutation.stepRun,
    {
      expectedVersion: startCommand.start.startedStepRunVersion,
      expectedDigest: startCommand.start.startedStepRunDigest,
      mutationId: identity.mutationId,
      to: failed ? 'failed' : 'succeeded',
      atMs: NOW + 25,
      ...(failed
        ? {
            resultCode: 'model_provider_failed',
            errorSummary: 'Model invocation failed',
          }
        : { outputRef: 'model-invocation:request-a' }),
    },
    {
      expectedRunVersion: 2,
      expectedRunEventSequence: 2,
      eventId: identity.eventId,
      dedupeKey: identity.dedupeKey,
      actor: { type: 'executor', id: 'model-gateway' },
    },
  );
  return createModelInvocationCompletionCommand(
    startCommand.start,
    audit(failed ? 'failed' : 'completed', {
      occurredAtMs: NOW + 25,
      outputBytes: failed ? 0 : 12,
      usage,
      errorCode,
    }),
    mutation,
  );
}

test('usage ledger derives one immutable content-free billing fact', () => {
  const start = startFixture().start;
  const completion = completionFixture().completion;
  const ledger = createModelInvocationUsageLedgerRecord(start, completion);

  assert.ok(ledger);
  assert.equal(ledger.schema, MODEL_INVOCATION_USAGE_LEDGER_SCHEMA);
  assert.equal(ledger.invocationId, completion.invocationId);
  assert.equal(ledger.completionDigest, completion.completionDigest);
  assert.equal(ledger.provider, start.provider);
  assert.equal(ledger.model, start.model);
  assert.equal(ledger.policyRevision, start.policyRevision);
  assert.equal(ledger.outcome, 'succeeded');
  assert.equal(ledger.inputTokens, 5);
  assert.equal(ledger.outputTokens, 2);
  assert.equal(ledger.totalTokens, 7);
  assert.equal(ledger.costMicros, 11);
  assert.deepEqual(
    createModelInvocationUsageLedgerRecord(start, completion),
    ledger,
  );
  assert.deepEqual(normalizeModelInvocationUsageLedgerRecord(ledger), ledger);
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(JSON.stringify(ledger).includes('top secret prompt'), false);
});

test('failed provider completion remains billable when usage is known', () => {
  const start = startFixture().start;
  const completion = completionFixture({
    errorCode: 'MODEL_PROVIDER_FAILED',
    usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
  }).completion;
  const ledger = createModelInvocationUsageLedgerRecord(start, completion);

  assert.ok(ledger);
  assert.equal(ledger.outcome, 'failed');
  assert.equal(ledger.totalTokens, 5);
  assert.equal(ledger.costMicros, null);
});

test('completion without usage creates no synthetic zero-cost fact', () => {
  const start = startFixture().start;
  const completion = completionFixture({
    errorCode: 'MODEL_PROVIDER_FAILED',
    usage: null,
  }).completion;

  assert.equal(createModelInvocationUsageLedgerRecord(start, completion), null);
});

test('detached completion and digest tampering fail closed', () => {
  const start = startFixture().start;
  const completion = completionFixture().completion;
  const ledger = createModelInvocationUsageLedgerRecord(start, completion);

  assert.throws(
    () =>
      createModelInvocationUsageLedgerRecord(
        startFixture('project-b').start,
        completion,
      ),
    InvalidModelInvocationUsageLedgerError,
  );
  assert.throws(
    () =>
      normalizeModelInvocationUsageLedgerRecord({
        ...ledger,
        totalTokens: ledger.totalTokens + 1,
      }),
    InvalidModelInvocationUsageLedgerError,
  );
  assert.throws(
    () =>
      normalizeModelInvocationUsageLedgerRecord({
        ...ledger,
        ledgerDigest: '0'.repeat(64),
      }),
    InvalidModelInvocationUsageLedgerError,
  );
});

test('Project usage query is bounded and cursor stays inside its window', () => {
  const query = {
    projectId: 'project-a',
    fromMsInclusive: NOW,
    toMsExclusive: NOW + 100,
    limit: 128,
    after: { settledAtMs: NOW + 25, invocationId: 'request-a' },
  };

  assert.deepEqual(normalizeModelInvocationUsageLedgerQuery(query), query);
  assert.deepEqual(
    normalizeModelInvocationUsageLedgerSummaryQuery({
      projectId: 'project-a',
      fromMsInclusive: NOW,
      toMsExclusive: NOW + 100,
    }),
    {
      projectId: 'project-a',
      fromMsInclusive: NOW,
      toMsExclusive: NOW + 100,
    },
  );
  assert.throws(
    () =>
      normalizeModelInvocationUsageLedgerQuery({
        ...query,
        toMsExclusive:
          query.fromMsInclusive +
          MAX_MODEL_INVOCATION_USAGE_QUERY_WINDOW_MS +
          1,
      }),
    InvalidModelInvocationUsageLedgerError,
  );
  assert.throws(
    () =>
      normalizeModelInvocationUsageLedgerQuery({
        ...query,
        after: { ...query.after, settledAtMs: NOW - 1 },
      }),
    InvalidModelInvocationUsageLedgerError,
  );
  assert.throws(
    () => normalizeModelInvocationUsageLedgerQuery({ ...query, limit: 129 }),
    InvalidModelInvocationUsageLedgerError,
  );
});
