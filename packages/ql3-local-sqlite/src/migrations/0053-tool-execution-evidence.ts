import { defineLocalSqliteMigration } from './sqlMigration';

export const local0053ToolExecutionEvidenceMigration =
  defineLocalSqliteMigration({
    id: '0053-tool-execution-evidence',
    statements: [
      `
CREATE TABLE "ToolExecutionTraceAnchors" (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  invocation_plan_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  redaction_contract_digest TEXT NOT NULL,
  audit_contract_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  trace_digest TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  CONSTRAINT tool_execution_trace_anchors_pkey
    PRIMARY KEY (trace_id, span_id),
  CONSTRAINT ql3_tool_execution_trace_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE CASCADE,
  CONSTRAINT ql3_tool_execution_trace_identity_check CHECK (
    length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*' AND
    length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*' AND
    (parent_span_id IS NULL OR (
      length(parent_span_id) = 16 AND
      parent_span_id NOT GLOB '*[^0-9a-f]*' AND
      parent_span_id <> span_id
    )) AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_tool_execution_trace_digest_check CHECK (
    length(invocation_plan_digest) = 64 AND
      invocation_plan_digest NOT GLOB '*[^0-9a-f]*' AND
    length(binding_digest) = 64 AND
      binding_digest NOT GLOB '*[^0-9a-f]*' AND
    length(adapter_digest) = 64 AND
      adapter_digest NOT GLOB '*[^0-9a-f]*' AND
    length(redaction_contract_digest) = 64 AND
      redaction_contract_digest NOT GLOB '*[^0-9a-f]*' AND
    length(audit_contract_digest) = 64 AND
      audit_contract_digest NOT GLOB '*[^0-9a-f]*' AND
    length(trace_digest) = 64 AND
      trace_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_execution_trace_time_check CHECK (
    created_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_execution_trace_json_check CHECK (
    length(CAST(trace_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(trace_json) AND json_type(trace_json) = 'object' AND
    json_extract(trace_json, '$.schema') =
      'qinglong/tool-execution-trace-anchor@v1' AND
    json_extract(trace_json, '$.traceId') = trace_id AND
    json_extract(trace_json, '$.spanId') = span_id AND
    json_extract(trace_json, '$.parentSpanId') IS parent_span_id AND
    json_extract(trace_json, '$.projectId') = project_id AND
    json_extract(trace_json, '$.runId') = run_id AND
    json_extract(trace_json, '$.stepRunId') = step_run_id AND
    json_extract(trace_json, '$.invocationPlanDigest') =
      invocation_plan_digest AND
    json_extract(trace_json, '$.bindingDigest') = binding_digest AND
    json_extract(trace_json, '$.adapterDigest') = adapter_digest AND
    json_extract(trace_json, '$.redactionContractDigest') =
      redaction_contract_digest AND
    json_extract(trace_json, '$.auditContractDigest') =
      audit_contract_digest AND
    json_extract(trace_json, '$.createdAtMs') IS created_at_ms AND
    json_extract(trace_json, '$.traceDigest') = trace_digest
  )
)
      `,
      `CREATE INDEX ql3_tool_execution_trace_run_idx ON "ToolExecutionTraceAnchors" (run_id, created_at_ms, trace_id, span_id)`,
      `CREATE INDEX ql3_tool_execution_trace_step_idx ON "ToolExecutionTraceAnchors" (run_id, step_run_id, created_at_ms, trace_id, span_id)`,
      `
CREATE TABLE "ToolExecutionAuditReceipts" (
  event_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  trace_digest TEXT NOT NULL,
  invocation_plan_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  audit_record_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  receipt_digest TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_execution_audit_event_fk
    FOREIGN KEY (event_id)
    REFERENCES "QingLong3SecurityAuditEvents" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_execution_audit_trace_fk
    FOREIGN KEY (trace_id, span_id)
    REFERENCES "ToolExecutionTraceAnchors" (trace_id, span_id)
    ON DELETE CASCADE,
  CONSTRAINT ql3_tool_execution_audit_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE CASCADE,
  CONSTRAINT ql3_tool_execution_audit_identity_check CHECK (
    length(event_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*' AND
    length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_execution_audit_digest_check CHECK (
    length(trace_digest) = 64 AND
      trace_digest NOT GLOB '*[^0-9a-f]*' AND
    length(invocation_plan_digest) = 64 AND
      invocation_plan_digest NOT GLOB '*[^0-9a-f]*' AND
    length(binding_digest) = 64 AND
      binding_digest NOT GLOB '*[^0-9a-f]*' AND
    length(audit_record_digest) = 64 AND
      audit_record_digest NOT GLOB '*[^0-9a-f]*' AND
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_execution_audit_time_check CHECK (
    created_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_execution_audit_json_check CHECK (
    length(CAST(audit_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(audit_json) AND json_type(audit_json) = 'object' AND
    json_extract(audit_json, '$.eventId') = event_id AND
    json_extract(audit_json, '$.projectId') = project_id AND
    json_extract(audit_json, '$.operationId') = 'tool.invoke.start' AND
    json_extract(audit_json, '$.outcome') = 'allowed' AND
    json_type(audit_json, '$.fence') = 'object' AND
    json_extract(audit_json, '$.occurredAtMs') IS created_at_ms
  ),
  CONSTRAINT ql3_tool_execution_audit_receipt_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/tool-execution-audit-receipt@v1' AND
    json_extract(receipt_json, '$.eventId') = event_id AND
    json_extract(receipt_json, '$.projectId') = project_id AND
    json_extract(receipt_json, '$.runId') = run_id AND
    json_extract(receipt_json, '$.stepRunId') = step_run_id AND
    json_extract(receipt_json, '$.traceId') = trace_id AND
    json_extract(receipt_json, '$.spanId') = span_id AND
    json_extract(receipt_json, '$.traceDigest') = trace_digest AND
    json_extract(receipt_json, '$.invocationPlanDigest') =
      invocation_plan_digest AND
    json_extract(receipt_json, '$.bindingDigest') = binding_digest AND
    json_extract(receipt_json, '$.auditRecordDigest') =
      audit_record_digest AND
    json_extract(receipt_json, '$.createdAtMs') IS created_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_tool_execution_audit_trace_uidx ON "ToolExecutionAuditReceipts" (trace_id, span_id)`,
      `CREATE INDEX ql3_tool_execution_audit_run_idx ON "ToolExecutionAuditReceipts" (run_id, created_at_ms, trace_id, span_id)`,
      `CREATE INDEX ql3_tool_execution_audit_step_idx ON "ToolExecutionAuditReceipts" (run_id, step_run_id, created_at_ms, event_id)`,
    ],
  });
