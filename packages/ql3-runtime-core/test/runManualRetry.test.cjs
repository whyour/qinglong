const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidRunManualRetryError,
  RUN_MANUAL_RETRY_SCHEMA,
  RunManualRetryRateLimitedError,
  createRunManualRetryResponseBody,
  normalizeRunManualRetryCommand,
  parseRunManualRetryRequestBody,
} = require('../dist/run/manual-retry/runManualRetry.js');

const IDS = Object.freeze({
  mutationId: '019f9000-0000-4000-8000-000000000001',
  runId: '019f9000-0000-4000-8000-000000000002',
  attemptId: '019f9000-0000-4000-8000-000000000003',
  createdEventId: '019f9000-0000-4000-8000-000000000004',
  queuedEventId: '019f9000-0000-4000-8000-000000000005',
  auditEventId: '019f9000-0000-4000-8000-000000000006',
});

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    mutationId: IDS.mutationId,
    expectedRunVersion: 7,
    expectedRunStatus: 'failed',
    runId: IDS.runId,
    attemptId: IDS.attemptId,
    createdEventId: IDS.createdEventId,
    queuedEventId: IDS.queuedEventId,
    auditEventId: IDS.auditEventId,
    requestId: 'run-retry-request-1',
    principal: {
      subject: { type: 'user', id: 'operator-1' },
      authenticationId: 'local_console:proof-1',
      authenticatedAtMs: 10_000,
      expiresAtMs: 20_000,
      assurance: 'local_console',
    },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

test('normalizes one strongly authorized terminal Run retry command', () => {
  const request = parseRunManualRetryRequestBody({
    schema: RUN_MANUAL_RETRY_SCHEMA,
    mutationId: IDS.mutationId,
    expectedRunVersion: 7,
    expectedRunStatus: 'timed_out',
  });
  assert.equal(request.expectedRunStatus, 'timed_out');
  const normalized = normalizeRunManualRetryCommand(command());
  assert.equal(normalized.principal.assurance, 'local_console');
  assert.equal(Object.isFrozen(normalized), true);
});

test('rejects reopened states, weak principals and widened commands', () => {
  assert.throws(
    () =>
      parseRunManualRetryRequestBody({
        schema: RUN_MANUAL_RETRY_SCHEMA,
        mutationId: IDS.mutationId,
        expectedRunVersion: 7,
        expectedRunStatus: 'lost',
      }),
    InvalidRunManualRetryError,
  );
  assert.throws(
    () =>
      normalizeRunManualRetryCommand(
        command({
          principal: { ...command().principal, assurance: 'single_factor' },
        }),
      ),
    /strong User/,
  );
  assert.throws(
    () => normalizeRunManualRetryCommand({ ...command(), hidden: true }),
    InvalidRunManualRetryError,
  );
});

test('publishes only the bounded new-Run retry result', () => {
  assert.deepEqual(
    createRunManualRetryResponseBody({
      status: 'accepted',
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      sourceRunStatus: 'failed',
      sourceRunVersion: 7,
      runId: IDS.runId,
      retryOfRunId: 'source-run-1',
      taskId: 'task-1',
      taskRevision: `v1:${'a'.repeat(64)}`,
      attemptId: IDS.attemptId,
      runStatus: 'queued',
      runVersion: 2,
      eventSequence: 2,
      executorType: 'local_process',
      executionRevisionDigest: 'b'.repeat(64),
      createdAtMs: 11_000,
    }),
    {
      schema: RUN_MANUAL_RETRY_SCHEMA,
      status: 'accepted',
      projectId: 'project-1',
      sourceRunId: 'source-run-1',
      sourceRunStatus: 'failed',
      sourceRunVersion: 7,
      runId: IDS.runId,
      retryOfRunId: 'source-run-1',
      taskId: 'task-1',
      taskRevision: `v1:${'a'.repeat(64)}`,
      attemptId: IDS.attemptId,
      runStatus: 'queued',
      runVersion: 2,
      eventSequence: 2,
      executorType: 'local_process',
      executionRevisionDigest: 'b'.repeat(64),
      createdAtMs: 11_000,
    },
  );
  assert.equal(new RunManualRetryRateLimitedError(250).retryAfterMs, 250);
  assert.throws(() => new RunManualRetryRateLimitedError(0));
});
