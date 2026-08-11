const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ToolExecutionEvidenceConflictError,
  ToolExecutionEvidenceUnavailableError,
  createToolExecutionEvidenceBundle,
} = require('@qinglong/runtime-core/tool-execution-evidence');
const {
  createStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqliteStepRunRepository,
} = require('../dist/run/stepRunRepository');
const {
  LocalSqliteToolExecutionEvidenceRepository,
} = require('../dist/tool-execution/toolExecutionEvidenceRepository');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const DIGEST_E = 'e'.repeat(64);

async function harness() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3Projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES ('project-001', 'Project', 'project-001', 'active', 1, 1, 1)`,
    )
    .run();
  client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version,
         event_sequence, priority, created_at_ms
       ) VALUES (
         'run-001', 'project-001', 'task-001', 'revision-001', 'manual',
         'manual', 'runtime', 'running', 0, 0, 0, 1
       )`,
    )
    .run();
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    authority,
    stepRuns: new LocalSqliteStepRunRepository(authority),
    evidence: new LocalSqliteToolExecutionEvidenceRepository(authority),
    close: () => authority.close(),
  };
}

function stepMutation(index, expectedRunVersion) {
  const suffix = String(index).padStart(3, '0');
  return createStepRunMutation(
    {
      id: `step-run-${suffix}`,
      runId: 'run-001',
      stepKey: `workflow.tool-${suffix}`,
      kind: 'tool',
      definitionRef: `tool:demo.tool-${suffix}@1.0.0`,
      definitionDigest: DIGEST_A,
      required: true,
      initialStatus: 'ready',
      mutationId: `step-create-${suffix}`,
      createdAtMs: 900 + index,
    },
    {
      expectedRunVersion,
      expectedRunEventSequence: expectedRunVersion,
      eventId: `50000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      dedupeKey: `step-create:step-run-${suffix}`,
      actor: { type: 'agent', id: 'agent-001' },
    },
  );
}

function evidence(index, overrides = {}) {
  const suffix = String(index).padStart(3, '0');
  const createdAtMs = 1_000 + index;
  return createToolExecutionEvidenceBundle({
    traceId: index.toString(16).padStart(32, '0'),
    spanId: (index + 16).toString(16).padStart(16, '0'),
    projectId: 'project-001',
    runId: 'run-001',
    stepRunId: `step-run-${suffix}`,
    invocationPlanDigest: DIGEST_A,
    bindingDigest: DIGEST_B,
    adapterDigest: DIGEST_C,
    redactionContractDigest: DIGEST_D,
    auditContractDigest: DIGEST_E,
    audit: {
      eventId: `60000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      requestId: `tool-request-${suffix}`,
      operationId: 'tool.invoke.start',
      projectId: 'project-001',
      subject: { type: 'agent', id: 'agent-001' },
      authenticationId: 'auth-agent-001',
      outcome: 'allowed',
      reasons: ['tool_execution_start'],
      fence: { projectVersion: 1, bindingVersion: 1 },
      occurredAtMs: createdAtMs,
    },
    createdAtMs,
    ...overrides,
  });
}

test('atomically prepares and exactly replays durable Trace and Audit evidence', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  await value.stepRuns.apply(stepMutation(1, 0));
  const bundle = evidence(1);

  assert.deepEqual(await value.evidence.prepare(bundle), {
    status: 'created',
    bundle,
  });
  assert.deepEqual(await value.evidence.prepare(bundle), {
    status: 'existing',
    bundle,
  });
  assert.deepEqual(
    await value.evidence.findByTrace(
      bundle.trace.traceId,
      bundle.trace.spanId,
    ),
    bundle,
  );
  assert.deepEqual(
    await value.evidence.findByAuditEventId(bundle.audit.eventId),
    bundle,
  );
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM "ToolExecutionTraceAnchors") AS traces,
             (SELECT COUNT(*) FROM "ToolExecutionAuditReceipts") AS receipts,
             (SELECT COUNT(*) FROM "QingLong3SecurityAuditEvents"
                WHERE operation_id = 'tool.invoke.start') AS audits`,
        )
        .get(),
    },
    { traces: 1, receipts: 1, audits: 1 },
  );
});

test('rejects reused Trace or Audit identity with different content', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  await value.stepRuns.apply(stepMutation(1, 0));
  const first = evidence(1);
  await value.evidence.prepare(first);

  const reusedTrace = evidence(1, {
    audit: {
      ...first.audit,
      eventId: '60000000-0000-4000-8000-000000000099',
      requestId: 'tool-request-reused',
    },
  });
  await assert.rejects(
    value.evidence.prepare(reusedTrace),
    ToolExecutionEvidenceConflictError,
  );

  const reusedAudit = evidence(1, {
    traceId: 'f'.repeat(32),
    spanId: 'e'.repeat(16),
    audit: first.audit,
  });
  await assert.rejects(
    value.evidence.prepare(reusedAudit),
    ToolExecutionEvidenceConflictError,
  );
});

test('requires one ready Tool StepRun in the same Project and rolls back audit', async (t) => {
  const value = await harness();
  t.after(() => value.close());

  await assert.rejects(
    value.evidence.prepare(evidence(1)),
    ToolExecutionEvidenceConflictError,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3SecurityAuditEvents"
         WHERE operation_id = 'tool.invoke.start'`,
      )
      .get().count,
    0,
  );
});

test('lists evidence with stable bounded keyset pagination', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  for (let index = 1; index <= 3; index += 1) {
    await value.stepRuns.apply(stepMutation(index, index - 1));
    await value.evidence.prepare(evidence(index));
  }
  const first = await value.evidence.listByRun({
    runId: 'run-001',
    limit: 2,
  });
  assert.equal(first.bundles.length, 2);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.next, {
    createdAtMs: first.bundles[1].trace.createdAtMs,
    traceId: first.bundles[1].trace.traceId,
    spanId: first.bundles[1].trace.spanId,
  });
  const second = await value.evidence.listByRun({
    runId: 'run-001',
    limit: 2,
    after: first.next,
  });
  assert.equal(second.bundles.length, 1);
  assert.equal(second.truncated, false);
  assert.equal(second.next, undefined);
});

test('fails closed when durable JSON no longer matches mirrored columns', async (t) => {
  const value = await harness();
  t.after(() => value.close());
  await value.stepRuns.apply(stepMutation(1, 0));
  const bundle = evidence(1);
  await value.evidence.prepare(bundle);
  value.client.exec('PRAGMA ignore_check_constraints = ON');
  value.client
    .prepare(
      `UPDATE "ToolExecutionTraceAnchors"
       SET trace_json = json_set(trace_json, '$.projectId', 'project-other')`,
    )
    .run();
  await assert.rejects(
    value.evidence.findByTrace(bundle.trace.traceId, bundle.trace.spanId),
    ToolExecutionEvidenceUnavailableError,
  );
});

test('publishes evidence authority only through its explicit subpath', () => {
  const root = require('@qinglong/local-sqlite');
  const runtime = require('@qinglong/local-sqlite/runtime');
  const authority = require('@qinglong/local-sqlite/tool-execution-evidence');
  assert.equal(root.LocalSqliteToolExecutionEvidenceRepository, undefined);
  assert.equal(runtime.LocalSqliteToolExecutionEvidenceRepository, undefined);
  assert.equal(
    typeof authority.LocalSqliteToolExecutionEvidenceRepository,
    'function',
  );
});
