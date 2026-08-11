const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  InvalidToolExecutionEvidenceError,
  MAX_TOOL_EXECUTION_EVIDENCE_PAGE_SIZE,
  TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA,
  TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA,
  TOOL_EXECUTION_START_AUDIT_OPERATION,
  TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA,
  createToolExecutionEvidenceBundle,
  normalizeListToolExecutionEvidenceQuery,
  normalizeListToolExecutionEvidenceResult,
  normalizeToolExecutionAuditReceipt,
  normalizeToolExecutionEvidenceBundle,
  normalizeToolExecutionTraceAnchor,
  toolExecutionAdmissionEvidence,
  toolExecutionAuditRecordDigest,
} = require('../dist/tool-execution/toolExecutionEvidence');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const DIGEST_E = 'e'.repeat(64);

function audit(overrides = {}) {
  return {
    eventId: '40000000-0000-4000-8000-000000000001',
    requestId: 'tool-request-001',
    operationId: TOOL_EXECUTION_START_AUDIT_OPERATION,
    projectId: 'project-001',
    subject: { type: 'agent', id: 'agent-001' },
    authenticationId: 'auth-agent-001',
    outcome: 'allowed',
    reasons: ['tool_execution_start'],
    fence: { projectVersion: 3, bindingVersion: 4 },
    occurredAtMs: 1_000,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    projectId: 'project-001',
    runId: 'run-001',
    stepRunId: 'step-run-001',
    invocationPlanDigest: DIGEST_A,
    bindingDigest: DIGEST_B,
    adapterDigest: DIGEST_C,
    redactionContractDigest: DIGEST_D,
    auditContractDigest: DIGEST_E,
    audit: audit(),
    createdAtMs: 1_000,
    ...overrides,
  };
}

function copy(value) {
  return structuredClone(value);
}

test('creates one immutable low-sensitive Trace and Audit evidence bundle', () => {
  const bundle = createToolExecutionEvidenceBundle(input());
  assert.equal(bundle.schema, TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA);
  assert.equal(bundle.trace.schema, TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA);
  assert.equal(bundle.receipt.schema, TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA);
  assert.equal(bundle.trace.parentSpanId, null);
  assert.match(bundle.trace.traceDigest, /^[0-9a-f]{64}$/);
  assert.match(bundle.receipt.auditRecordDigest, /^[0-9a-f]{64}$/);
  assert.match(bundle.receipt.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.trace), true);
  assert.equal(Object.isFrozen(bundle.audit), true);
  assert.equal(Object.isFrozen(bundle.receipt), true);
  assert.deepEqual(normalizeToolExecutionEvidenceBundle(bundle), bundle);
  assert.deepEqual(toolExecutionAdmissionEvidence(bundle), {
    trace: {
      traceId: bundle.trace.traceId,
      spanId: bundle.trace.spanId,
      digest: bundle.trace.traceDigest,
    },
    audit: {
      eventId: bundle.audit.eventId,
      digest: bundle.receipt.receiptDigest,
    },
  });
});

test('uses canonical domain-separated digests and binds every authority fact', () => {
  const first = createToolExecutionEvidenceBundle(input());
  const replay = createToolExecutionEvidenceBundle(input());
  assert.deepEqual(replay, first);
  assert.equal(
    toolExecutionAuditRecordDigest(first.audit),
    first.receipt.auditRecordDigest,
  );

  const changed = createToolExecutionEvidenceBundle(
    input({
      adapterDigest: 'f'.repeat(64),
      audit: audit({
        eventId: '40000000-0000-4000-8000-000000000002',
      }),
    }),
  );
  assert.notEqual(changed.trace.traceDigest, first.trace.traceDigest);
  assert.notEqual(changed.receipt.receiptDigest, first.receipt.receiptDigest);
});

test('rejects non-start, denied, unfenced and cross-Project audit records', () => {
  for (const invalidAudit of [
    audit({ operationId: 'tool.invoke.finish' }),
    audit({ outcome: 'denied' }),
    audit({ fence: null }),
    audit({ projectId: 'project-other' }),
    audit({ occurredAtMs: 999 }),
  ]) {
    assert.throws(
      () => createToolExecutionEvidenceBundle(input({ audit: invalidAudit })),
      InvalidToolExecutionEvidenceError,
    );
  }
});

test('rejects trace identity, parent loops, unknown fields and digest tampering', () => {
  assert.throws(
    () => createToolExecutionEvidenceBundle(input({ traceId: '1'.repeat(31) })),
    InvalidToolExecutionEvidenceError,
  );
  assert.throws(
    () =>
      createToolExecutionEvidenceBundle(
        input({ parentSpanId: '2'.repeat(16) }),
      ),
    InvalidToolExecutionEvidenceError,
  );
  assert.throws(
    () => createToolExecutionEvidenceBundle({ ...input(), secret: 'value' }),
    InvalidToolExecutionEvidenceError,
  );

  const bundle = createToolExecutionEvidenceBundle(input());
  assert.throws(
    () =>
      normalizeToolExecutionTraceAnchor({
        ...copy(bundle.trace),
        traceDigest: '0'.repeat(64),
      }),
    InvalidToolExecutionEvidenceError,
  );
  assert.throws(
    () =>
      normalizeToolExecutionAuditReceipt({
        ...copy(bundle.receipt),
        receiptDigest: '0'.repeat(64),
      }),
    InvalidToolExecutionEvidenceError,
  );
});

test('rejects detached Trace, Audit and receipt relationships', () => {
  const bundle = createToolExecutionEvidenceBundle(input());
  const other = createToolExecutionEvidenceBundle(
    input({
      traceId: '3'.repeat(32),
      spanId: '4'.repeat(16),
      stepRunId: 'step-run-002',
      audit: audit({
        eventId: '40000000-0000-4000-8000-000000000002',
      }),
    }),
  );
  assert.throws(
    () =>
      normalizeToolExecutionEvidenceBundle({
        ...copy(bundle),
        receipt: other.receipt,
      }),
    InvalidToolExecutionEvidenceError,
  );
  assert.throws(
    () =>
      normalizeToolExecutionEvidenceBundle({
        ...copy(bundle),
        audit: other.audit,
      }),
    InvalidToolExecutionEvidenceError,
  );
});

test('normalizes bounded stable evidence pagination', () => {
  const first = createToolExecutionEvidenceBundle(input());
  const second = createToolExecutionEvidenceBundle(
    input({
      traceId: '3'.repeat(32),
      spanId: '4'.repeat(16),
      audit: audit({
        eventId: '40000000-0000-4000-8000-000000000002',
        occurredAtMs: 1_001,
      }),
      createdAtMs: 1_001,
    }),
  );
  const query = normalizeListToolExecutionEvidenceQuery({
    runId: 'run-001',
    limit: 2,
  });
  assert.deepEqual(
    normalizeListToolExecutionEvidenceResult(
      {
        bundles: [first, second],
        truncated: true,
        next: {
          createdAtMs: second.trace.createdAtMs,
          traceId: second.trace.traceId,
          spanId: second.trace.spanId,
        },
      },
      query,
    ).bundles,
    [first, second],
  );
  assert.throws(
    () =>
      normalizeListToolExecutionEvidenceQuery({
        runId: 'run-001',
        limit: MAX_TOOL_EXECUTION_EVIDENCE_PAGE_SIZE + 1,
      }),
    InvalidToolExecutionEvidenceError,
  );
  assert.throws(
    () =>
      normalizeListToolExecutionEvidenceResult(
        { bundles: [second, first], truncated: false },
        query,
      ),
    InvalidToolExecutionEvidenceError,
  );
});

test('publishes the same pure contract through root and explicit subpath', () => {
  const root = require('../dist');
  const subpath = require('../dist/tool-execution/toolExecutionEvidence');
  assert.equal(
    root.createToolExecutionEvidenceBundle,
    subpath.createToolExecutionEvidenceBundle,
  );
  const source = readFileSync(
    join(__dirname, '../src/tool-execution/toolExecutionEvidence.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /node:(?:fs|child_process|net|http|https)|setInterval|setTimeout|execute|handler/i,
  );
});
