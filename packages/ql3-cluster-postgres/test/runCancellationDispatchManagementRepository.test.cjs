'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidRunCancellationDispatchManagementError,
  PostgresRunCancellationDispatchManagementRepository,
  RunCancellationDispatchManagementConflictError,
} = require('@qinglong/cluster-postgres/run-manager');

const NOW = 1_000_000;

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    requestId: 'request-1',
    auditEventId: '019f9600-0000-4000-8000-000000000001',
    principal: {
      subject: { type: 'user', id: 'operator-1' },
      authenticationId: 'oidc:run-management-1',
      authenticatedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
      assurance: 'multi_factor',
    },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

function rearmCommand(overrides = {}) {
  return command({
    requestId: 'request-rearm-1',
    auditEventId: '019f9600-0000-4000-8000-000000000011',
    mutationId: '019f9600-0000-4000-8000-000000000012',
    eventId: '019f9600-0000-4000-8000-000000000013',
    expectedDispatchVersion: 3,
    expectedLastResult: 'identity_mismatch',
    retryDelayMs: 5_000,
    ...overrides,
  });
}

function summaryCommand(overrides = {}) {
  const { runId: _runId, ...authority } = command();
  return { ...authority, ...overrides };
}

function blockedListCommand(after) {
  return {
    ...summaryCommand({
      requestId: 'request-blocked-1',
      auditEventId: '019f9600-0000-4000-8000-000000000021',
    }),
    ...(after === undefined ? {} : { after }),
  };
}

function runRow() {
  return {
    projectId: 'project-1',
    runStatus: 'running',
    runVersion: 6,
    eventSequence: 8,
    cancelRequestedAtMs: NOW - 2_000,
    cancelReason: 'user',
  };
}

function dispatchRow(overrides = {}) {
  return {
    attemptId: 'attempt-1',
    dispatchStatus: 'blocked',
    dispatchVersion: 3,
    dispatchCount: 1,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: null,
    lastResult: 'identity_mismatch',
    lastDispatchedAtMs: NOW - 1_500,
    dispatchCreatedAtMs: NOW - 1_900,
    dispatchUpdatedAtMs: NOW - 1_500,
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: text, params });
      if (
        text === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
        text === 'COMMIT' ||
        text === 'ROLLBACK' ||
        text.startsWith('SELECT set_config')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('transaction_timestamp()')) {
        return { rows: [{ nowMs: NOW }], rowCount: 1 };
      }
      if (text.includes('lock_run_management_policy_fence')) {
        return {
          rows: [{ matches: options.authorized !== false }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "ql3"."runs" WHERE id = $1 FOR UPDATE')) {
        return { rows: [runRow()], rowCount: 1 };
      }
      if (text.includes('FROM "ql3"."runs" WHERE id = $1')) {
        return { rows: [runRow()], rowCount: 1 };
      }
      if (
        text.includes('FROM "ql3"."run_events"') &&
        text.includes('dedupe_key = $2')
      ) {
        return { rows: options.replay ? [options.replay] : [], rowCount: 0 };
      }
      if (
        text.includes('FROM "ql3"."run_cancellation_dispatches" AS dispatch')
      ) {
        return {
          rows: [
            options.summary ?? {
              total: '5',
              pending: '1',
              leased: '1',
              retryWait: '1',
              dispatched: '1',
              blocked: '1',
              due: '1',
              expiredLease: '1',
              identityMismatch: '1',
              pidMismatch: '0',
              unsupported: '0',
              invalid: '0',
              oldestBlockedAtMs: String(NOW - 1_500),
            },
          ],
          rowCount: 1,
        };
      }
      if (
        text.startsWith(
          'SELECT run_id AS "runId", updated_at_ms AS "blockedAtMs"',
        )
      ) {
        return { rows: options.blockedRows ?? [], rowCount: 0 };
      }
      if (
        text.startsWith('SELECT attempt_id AS "attemptId"') &&
        !text.includes('dispatchStatus') &&
        !text.includes('FOR UPDATE')
      ) {
        return { rows: [{ attemptId: 'attempt-1' }], rowCount: 1 };
      }
      if (text.includes('FROM "ql3"."run_attempts"')) {
        return {
          rows: [{ attemptStatus: options.attemptStatus ?? 'running' }],
          rowCount: 1,
        };
      }
      if (
        text.includes('FROM "ql3"."run_cancellation_dispatches"') &&
        text.includes('FOR UPDATE')
      ) {
        return {
          rows: [
            dispatchRow({
              lastResult: options.lastResult ?? 'identity_mismatch',
            }),
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "ql3"."run_cancellation_dispatches"')) {
        return { rows: [dispatchRow()], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."runs"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."run_cancellation_dispatches"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "ql3"."run_events"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "ql3"."security_audit_events"')) {
        return { rows: [{ eventId: params[0] }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  const pool = { async connect() { return client; } };
  return {
    calls,
    repository: new PostgresRunCancellationDispatchManagementRepository(pool),
  };
}

test('inspects one low-sensitive blocked dispatch under run.read authority', async () => {
  const { calls, repository } = fixture();
  const result = await repository.inspect(command());
  assert.equal(result.operatorAction, 'rearm');
  assert.equal(result.dispatch.status, 'blocked');
  assert.equal(result.dispatch.lastResult, 'identity_mismatch');
  const dispatchRead = calls.find(({ sql }) =>
    sql.includes('FROM "ql3"."run_cancellation_dispatches"'),
  );
  assert.equal(dispatchRead.sql.includes('lease_owner'), false);
  assert.equal(dispatchRead.sql.includes('lease_token_digest'), false);
  assert.equal(
    calls.some(
      ({ sql }) =>
        sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
        sql.includes('$3'),
    ),
    true,
  );
});

test('summarizes one Project without exposing Run, Attempt or lease identity', async () => {
  const { calls, repository } = fixture();
  const result = await repository.summary(summaryCommand());
  assert.deepEqual(result, {
    projectId: 'project-1',
    observedAtMs: NOW,
    assessment: 'attention_required',
    operatorAction: 'inspect',
    dispatches: {
      total: 5,
      pending: 1,
      leased: 1,
      retryWait: 1,
      dispatched: 1,
      blocked: 1,
    },
    signals: { due: 1, expiredLease: 1 },
    blockingResults: {
      identityMismatch: 1,
      pidMismatch: 0,
      unsupported: 0,
      invalid: 0,
    },
    oldestBlockedAtMs: NOW - 1_500,
  });
  const read = calls.find(({ sql }) =>
    sql.includes('FROM "ql3"."run_cancellation_dispatches" AS dispatch'),
  );
  assert.deepEqual(read.params, ['project-1', NOW]);
  for (const forbidden of [
    'attempt_id AS',
    'run.id AS',
    'lease_owner',
    'lease_token',
    'lease_token_digest',
  ]) {
    assert.equal(read.sql.includes(forbidden), false);
  }
  const audit = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      params[2] === 'run.cancellation.summary',
  );
  assert.equal(audit.params[0], summaryCommand().auditEventId);
});

test('derives clear and converging assessments from fixed status counts', async () => {
  const clear = fixture({
    summary: {
      total: '1',
      pending: '0',
      leased: '0',
      retryWait: '0',
      dispatched: '1',
      blocked: '0',
      due: '0',
      expiredLease: '0',
      identityMismatch: '0',
      pidMismatch: '0',
      unsupported: '0',
      invalid: '0',
      oldestBlockedAtMs: null,
    },
  });
  assert.equal((await clear.repository.summary(summaryCommand())).assessment, 'clear');

  const converging = fixture({
    summary: {
      total: '1',
      pending: '0',
      leased: '0',
      retryWait: '1',
      dispatched: '0',
      blocked: '0',
      due: '1',
      expiredLease: '0',
      identityMismatch: '0',
      pidMismatch: '0',
      unsupported: '0',
      invalid: '0',
      oldestBlockedAtMs: null,
    },
  });
  const result = await converging.repository.summary(summaryCommand());
  assert.equal(result.assessment, 'converging');
  assert.equal(result.operatorAction, 'wait');
});

test('lists one fixed oldest-first blocked page with a snapshot cursor', async () => {
  const blockedRows = Array.from({ length: 17 }, (_, index) => ({
    runId: `run-${String(index + 1).padStart(2, '0')}`,
    blockedAtMs: String(NOW - 100 + index),
  }));
  const { calls, repository } = fixture({ blockedRows });
  const result = await repository.listBlocked(blockedListCommand());
  assert.equal(result.projectId, 'project-1');
  assert.equal(result.snapshotAtMs, NOW);
  assert.equal(result.observedAtMs, NOW);
  assert.equal(result.items.length, 16);
  assert.equal(result.items[0].runId, 'run-01');
  assert.equal(result.items[15].runId, 'run-16');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.nextCursor, {
    snapshotAtMs: NOW,
    blockedAtMs: NOW - 85,
    runId: 'run-16',
  });
  const read = calls.find(({ sql }) =>
    sql.startsWith(
      'SELECT run_id AS "runId", updated_at_ms AS "blockedAtMs"',
    ),
  );
  assert.deepEqual(read.params, ['project-1', NOW, null, '', 17]);
  assert.match(
    read.sql,
    /project_id = \$1 AND status = 'blocked'[\s\S]+ORDER BY updated_at_ms ASC, run_id ASC/,
  );
  const audit = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      params[2] === 'run.cancellation.blocked.list',
  );
  assert.equal(audit.params[0], blockedListCommand().auditEventId);
});

test('continues only inside the original blocked snapshot', async () => {
  const after = {
    snapshotAtMs: NOW - 50,
    blockedAtMs: NOW - 80,
    runId: 'run-03',
  };
  const { calls, repository } = fixture({
    blockedRows: [{ runId: 'run-04', blockedAtMs: String(NOW - 79) }],
  });
  const result = await repository.listBlocked(blockedListCommand(after));
  assert.equal(result.snapshotAtMs, NOW - 50);
  assert.equal(result.truncated, false);
  assert.equal(Object.hasOwn(result, 'nextCursor'), false);
  const read = calls.find(({ sql }) =>
    sql.startsWith(
      'SELECT run_id AS "runId", updated_at_ms AS "blockedAtMs"',
    ),
  );
  assert.deepEqual(read.params, [
    'project-1',
    NOW - 50,
    NOW - 80,
    'run-03',
    17,
  ]);
});

test('rearms an exact blocked dispatch with one event and allowed audit', async () => {
  const { calls, repository } = fixture();
  const result = await repository.rearm(rearmCommand());
  assert.deepEqual(result, {
    status: 'rearmed',
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    previousDispatchVersion: 3,
    dispatchVersion: 4,
    previousResult: 'identity_mismatch',
    retryDelayMs: 5_000,
    nextAttemptAtMs: NOW + 5_000,
    runVersion: 7,
    eventSequence: 9,
  });
  const update = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_cancellation_dispatches"'),
  );
  assert.deepEqual(update.params, [
    'run-1',
    4,
    NOW + 5_000,
    NOW,
    'attempt-1',
    3,
    'identity_mismatch',
  ]);
  const attemptRead = calls.find(({ sql }) =>
    sql.includes('FROM "ql3"."run_attempts"'),
  );
  assert.equal(attemptRead.sql.includes('FOR KEY SHARE'), false);
  const event = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"'),
  );
  assert.equal(event.params[0], rearmCommand().eventId);
  assert.equal(JSON.parse(event.params[6]).previous_result, 'identity_mismatch');
  assert.ok(
    calls.findIndex(({ sql }) =>
      sql.startsWith('UPDATE "ql3"."run_cancellation_dispatches"'),
    ) < calls.findIndex(({ sql }) => sql === 'COMMIT'),
  );
});

test('exact mutation replay returns the immutable receipt without another update', async () => {
  const replay = {
    eventId: rearmCommand().eventId,
    eventSequence: 9,
    eventType: 'run.cancel_dispatch_rearmed',
    actorType: 'user',
    actorId: 'operator-1',
    attemptId: 'attempt-1',
    payload: {
      schema: 'qinglong/run-cancellation-dispatch-rearm@v1',
      mutation_id: rearmCommand().mutationId,
      previous_dispatch_version: 3,
      dispatch_version: 4,
      previous_result: 'identity_mismatch',
      retry_delay_ms: 5_000,
      next_attempt_at_ms: NOW + 5_000,
      run_version: 7,
    },
  };
  const { calls, repository } = fixture({ replay });
  assert.equal((await repository.rearm(rearmCommand())).dispatchVersion, 4);
  assert.equal(calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
});

test('stale result and authorization changes fail closed before mutation', async () => {
  const stale = fixture({ lastResult: 'pid_mismatch' });
  await assert.rejects(
    stale.repository.rearm(rearmCommand()),
    (error) =>
      error instanceof RunCancellationDispatchManagementConflictError &&
      error.reason === 'dispatch_result_changed',
  );
  assert.equal(
    stale.calls.some(({ sql }) => sql.startsWith('UPDATE')),
    false,
  );

  const unauthorized = fixture({ authorized: false });
  await assert.rejects(
    unauthorized.repository.inspect(command()),
    (error) =>
      error instanceof RunCancellationDispatchManagementConflictError &&
      error.reason === 'authorization_changed',
  );
  assert.equal(
    unauthorized.calls.some(({ sql }) =>
      sql.includes('FROM "ql3"."runs"'),
    ),
    false,
  );
});

test('rejects malformed management authority before opening PostgreSQL', async () => {
  let opened = false;
  const repository = new PostgresRunCancellationDispatchManagementRepository({
    async connect() {
      opened = true;
      throw new Error('must not open');
    },
  });
  assert.throws(
    () => repository.rearm(rearmCommand({ retryDelayMs: 0 })),
    InvalidRunCancellationDispatchManagementError,
  );
  assert.equal(opened, false);
});
