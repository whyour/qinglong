const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createToolExecutionEvidenceBundle,
  ToolExecutionEvidenceConflictError,
  ToolExecutionEvidenceUnavailableError,
} = require('@qinglong/runtime-core/tool-execution-evidence');
const {
  PostgresToolExecutionEvidenceRepository,
} = require('@qinglong/cluster-postgres/tool-execution-evidence');

function evidence(overrides = {}) {
  const createdAtMs = overrides.createdAtMs ?? 1700000000000;
  return createToolExecutionEvidenceBundle({
    traceId: overrides.traceId ?? '1'.repeat(32),
    spanId: overrides.spanId ?? '2'.repeat(16),
    projectId: 'project-1',
    runId: 'run-1',
    stepRunId: 'step-1',
    invocationPlanDigest: '3'.repeat(64),
    bindingDigest: '4'.repeat(64),
    adapterDigest: '5'.repeat(64),
    redactionContractDigest: '6'.repeat(64),
    auditContractDigest: '7'.repeat(64),
    audit: {
      eventId:
        overrides.eventId ?? '12345678-1234-4234-9234-123456789abc',
      requestId: 'request-1',
      operationId: 'tool.invoke.start',
      projectId: 'project-1',
      subject: { type: 'user', id: 'user-1' },
      authenticationId: 'authentication-1',
      outcome: 'allowed',
      reasons: ['policy_allowed'],
      fence: { projectVersion: 4, bindingVersion: 7 },
      occurredAtMs: createdAtMs,
    },
    createdAtMs,
  });
}

function row(bundle, overrides = {}) {
  return {
    traceJson: bundle.trace,
    auditJson: bundle.audit,
    receiptJson: bundle.receipt,
    storedTraceId: bundle.trace.traceId,
    storedSpanId: bundle.trace.spanId,
    storedParentSpanId: bundle.trace.parentSpanId,
    traceProjectId: bundle.trace.projectId,
    traceRunId: bundle.trace.runId,
    traceStepRunId: bundle.trace.stepRunId,
    traceInvocationPlanDigest: bundle.trace.invocationPlanDigest,
    traceBindingDigest: bundle.trace.bindingDigest,
    storedAdapterDigest: bundle.trace.adapterDigest,
    storedRedactionContractDigest: bundle.trace.redactionContractDigest,
    storedAuditContractDigest: bundle.trace.auditContractDigest,
    traceCreatedAtMs: String(bundle.trace.createdAtMs),
    storedTraceDigest: bundle.trace.traceDigest,
    storedEventId: bundle.receipt.eventId,
    receiptProjectId: bundle.receipt.projectId,
    receiptRunId: bundle.receipt.runId,
    receiptStepRunId: bundle.receipt.stepRunId,
    receiptTraceId: bundle.receipt.traceId,
    receiptSpanId: bundle.receipt.spanId,
    receiptTraceDigest: bundle.receipt.traceDigest,
    receiptInvocationPlanDigest: bundle.receipt.invocationPlanDigest,
    receiptBindingDigest: bundle.receipt.bindingDigest,
    storedAuditRecordDigest: bundle.receipt.auditRecordDigest,
    receiptCreatedAtMs: String(bundle.receipt.createdAtMs),
    storedReceiptDigest: bundle.receipt.receiptDigest,
    ...overrides,
  };
}

function clientWith(handler) {
  const calls = [];
  let released = false;
  return {
    calls,
    get released() {
      return released;
    },
    async query(text, values = []) {
      calls.push({ text, values });
      if (
        text.startsWith('BEGIN') ||
        text.includes("set_config('") ||
        text === 'COMMIT' ||
        text === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      return handler(text, values, calls);
    },
    release() {
      released = true;
    },
  };
}

test('prepares audit, trace and receipt in one serializable transaction', async () => {
  const bundle = evidence();
  const client = clientWith(async (sql) => {
    if (sql.includes('WHERE receipt.event_id')) return { rows: [] };
    if (sql.includes('FROM "ql3"."step_runs" AS step')) {
      return {
        rows: [{ kind: 'tool', status: 'ready', projectId: 'project-1' }],
      };
    }
    if (sql.startsWith('INSERT INTO')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const pool = {
    async query() {
      throw new Error('pool query is not used by prepare');
    },
    async connect() {
      return client;
    },
  };

  const repository = new PostgresToolExecutionEvidenceRepository(pool);
  assert.deepEqual(await repository.prepare(bundle), {
    status: 'created',
    bundle,
  });
  assert.equal(client.released, true);
  assert.deepEqual(
    client.calls
      .map(({ text }) => text)
      .filter((sql) => sql.startsWith('INSERT INTO'))
      .map((sql) => sql.match(/"ql3"\."([^"]+)"/)[1]),
    [
      'security_audit_events',
      'tool_execution_trace_anchors',
      'tool_execution_audit_receipts',
    ],
  );
  assert.equal(
    client.calls.some(({ text }) => text === 'COMMIT'),
    true,
  );
  assert.equal(
    client.calls.some(({ text }) => text === 'ROLLBACK'),
    false,
  );
});

test('replays exact evidence and rejects identity reuse', async () => {
  const bundle = evidence();
  const stored = row(bundle);
  const exactClient = clientWith(async (sql) => {
    if (sql.includes('WHERE receipt.event_id')) return { rows: [stored] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const exact = new PostgresToolExecutionEvidenceRepository({
    async query() {
      throw new Error('unused');
    },
    async connect() {
      return exactClient;
    },
  });
  assert.deepEqual(await exact.prepare(bundle), {
    status: 'existing',
    bundle,
  });

  const changed = evidence({
    createdAtMs: bundle.trace.createdAtMs + 1,
    traceId: bundle.trace.traceId,
    spanId: bundle.trace.spanId,
    eventId: bundle.audit.eventId,
  });
  const conflictClient = clientWith(async (sql) => {
    if (sql.includes('WHERE receipt.event_id')) return { rows: [stored] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const conflict = new PostgresToolExecutionEvidenceRepository({
    async query() {
      throw new Error('unused');
    },
    async connect() {
      return conflictClient;
    },
  });
  await assert.rejects(
    conflict.prepare(changed),
    ToolExecutionEvidenceConflictError,
  );
  assert.equal(
    conflictClient.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
  assert.equal(conflictClient.released, true);
});

test('reads bounded evidence without SELECT authority on the audit table', async () => {
  const first = evidence();
  const second = evidence({
    createdAtMs: first.trace.createdAtMs + 1,
    traceId: '8'.repeat(32),
    spanId: '9'.repeat(16),
    eventId: '87654321-4321-4321-8321-cba987654321',
  });
  const calls = [];
  const repository = new PostgresToolExecutionEvidenceRepository({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('WHERE trace.trace_id')) {
        return { rows: [row(first)] };
      }
      if (text.includes('WHERE receipt.event_id')) {
        return { rows: [row(first)] };
      }
      if (text.includes('WHERE trace.run_id')) {
        return { rows: [row(first), row(second)] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    async connect() {
      throw new Error('unused');
    },
  });

  assert.deepEqual(
    await repository.findByTrace(first.trace.traceId, first.trace.spanId),
    first,
  );
  assert.deepEqual(
    await repository.findByAuditEventId(first.audit.eventId),
    first,
  );
  assert.deepEqual(
    await repository.listByRun({ runId: 'run-1', limit: 1 }),
    {
      bundles: [first],
      truncated: true,
      next: {
        createdAtMs: first.trace.createdAtMs,
        traceId: first.trace.traceId,
        spanId: first.trace.spanId,
      },
    },
  );
  assert.equal(
    calls.some(({ text }) =>
      text.includes('JOIN "ql3"."security_audit_events"'),
    ),
    false,
  );
  assert.deepEqual(calls.at(-1).values, ['run-1', null, 0, '', 2]);
});

test('rejects invalid lookups before SQL and fails closed on corrupt rows', async () => {
  let queries = 0;
  const repository = new PostgresToolExecutionEvidenceRepository({
    async query() {
      queries += 1;
      return {
        rows: [row(evidence(), { storedTraceDigest: '0'.repeat(64) })],
      };
    },
    async connect() {
      throw new Error('unused');
    },
  });
  await assert.rejects(repository.findByTrace('bad', 'also-bad'), {
    code: 'TOOL_EXECUTION_EVIDENCE_INVALID',
  });
  assert.equal(queries, 0);
  await assert.rejects(
    repository.findByTrace('1'.repeat(32), '2'.repeat(16)),
    ToolExecutionEvidenceUnavailableError,
  );
});

test('rolls back when the StepRun is not an admitted same-Project Tool step', async () => {
  const bundle = evidence();
  const client = clientWith(async (sql) => {
    if (sql.includes('WHERE receipt.event_id')) return { rows: [] };
    if (sql.includes('FROM "ql3"."step_runs" AS step')) {
      return {
        rows: [{ kind: 'task', status: 'ready', projectId: 'project-1' }],
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repository = new PostgresToolExecutionEvidenceRepository({
    async query() {
      throw new Error('unused');
    },
    async connect() {
      return client;
    },
  });
  await assert.rejects(
    repository.prepare(bundle),
    ToolExecutionEvidenceConflictError,
  );
  assert.equal(
    client.calls.some(({ text }) => text.startsWith('INSERT INTO')),
    false,
  );
  assert.equal(
    client.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
  assert.equal(client.released, true);
});
