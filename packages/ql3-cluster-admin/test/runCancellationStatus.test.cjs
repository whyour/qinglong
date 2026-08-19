'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRunCancellationStatusCommand,
  formatRunCancellationStatusCard,
  projectRunCancellationStatus,
} = require('../dist/run-management/runCancellationStatus.js');

const uuids = [
  '019f9500-0000-4000-8000-000000000001',
  '019f9500-0000-4000-8000-000000000002',
  '019f9500-0000-4000-8000-000000000003',
];

function result(assessment) {
  const blocked = assessment === 'attention_required' ? 1 : 0;
  const pending = assessment === 'converging' ? 1 : 0;
  return {
    schemaVersion: 1,
    requestId: 'request-summary-1',
    result: {
      schemaVersion: 1,
      operation: 'run.cancellation.summary',
      summary: {
        schema: 'qinglong/run-cancellation-dispatch-summary@v1',
        projectId: 'project-1',
        observedAtMs: 1_700_000_000_000,
        assessment,
        operatorAction:
          assessment === 'clear'
            ? 'none'
            : assessment === 'converging'
            ? 'wait'
            : 'inspect',
        dispatches: {
          total: blocked + pending,
          pending,
          leased: 0,
          retryWait: 0,
          dispatched: 0,
          blocked,
        },
        signals: { due: pending, expiredLease: 0 },
        blockingResults: {
          identityMismatch: blocked,
          pidMismatch: 0,
          unsupported: 0,
          invalid: 0,
        },
        ...(blocked === 0 ? {} : { oldestBlockedAtMs: 1_699_999_999_000 }),
      },
    },
  };
}

test('builds one exact Project summary command without a command file', () => {
  let index = 0;
  assert.deepEqual(
    createRunCancellationStatusCommand('project-1', () => uuids[index++]),
    {
      schemaVersion: 1,
      operation: 'run.cancellation.summary',
      request: {
        projectId: 'project-1',
        requestId: uuids[0],
        auditEventId: uuids[1],
        failureAuditEventId: uuids[2],
        body: {
          schema: 'qinglong/run-cancellation-dispatch-summary-request@v1',
        },
      },
    },
  );
});

test('maps clear, converging and attention assessments to stable alert exits', () => {
  const cases = [
    ['clear', 'ok', 0],
    ['converging', 'warning', 10],
    ['attention_required', 'critical', 20],
  ];
  for (const [assessment, severity, exitCode] of cases) {
    const status = projectRunCancellationStatus(result(assessment));
    assert.equal(status.schema, 'qinglong/run-cancellation-status@v1');
    assert.equal(status.assessment, assessment);
    assert.equal(status.severity, severity);
    assert.equal(status.exitCode, exitCode);
    assert.equal(status.projectId, 'project-1');
    assert.equal(Object.hasOwn(status, 'oldestBlockedAtMs'), exitCode === 20);
  }
});

test('renders a deterministic low-sensitive operator card', () => {
  const card = formatRunCancellationStatusCard(
    projectRunCancellationStatus(result('attention_required')),
  );
  assert.match(card, /^QingLong 3\.0 \/ Cancellation Availability\n/);
  assert.match(card, /ASSESSMENT    ATTENTION REQUIRED/);
  assert.match(card, /ALERT         CRITICAL \(exit 20\)/);
  assert.match(card, /DISPATCHES    total=1 .* blocked=1/);
  assert.match(card, /BLOCKING      identity_mismatch=1/);
  assert.doesNotMatch(
    card,
    /runId|attemptId|leaseOwner|leaseToken|command|environment|secret/i,
  );
});

test('refuses to project a non-summary management result', () => {
  assert.throws(
    () =>
      projectRunCancellationStatus({
        schemaVersion: 1,
        requestId: 'request-1',
        result: { schemaVersion: 1, operation: 'run.stop', stop: {} },
      }),
    /requires a summary result/,
  );
});
