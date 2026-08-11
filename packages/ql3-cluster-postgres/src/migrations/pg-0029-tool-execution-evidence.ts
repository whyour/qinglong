import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V27 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V28 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_evidence":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0029ToolExecutionEvidenceMigration =
  definePostgresSqlMigration({
    id: 'pg-0029-tool-execution-evidence',
    statements: [
      `
CREATE TABLE "ql3"."tool_execution_trace_anchors" (
  trace_id char(32) NOT NULL,
  span_id char(16) NOT NULL,
  parent_span_id char(16),
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  invocation_plan_digest char(64) NOT NULL,
  binding_digest char(64) NOT NULL,
  adapter_digest char(64) NOT NULL,
  redaction_contract_digest char(64) NOT NULL,
  audit_contract_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  trace_digest char(64) NOT NULL,
  trace_json jsonb NOT NULL,
  CONSTRAINT tool_execution_trace_anchors_pkey
    PRIMARY KEY (trace_id, span_id),
  CONSTRAINT ql3_tool_execution_trace_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE CASCADE,
  CONSTRAINT ql3_tool_execution_trace_identity_check CHECK (
    trace_id ~ '^[0-9a-f]{32}$' AND
    span_id ~ '^[0-9a-f]{16}$' AND
    (parent_span_id IS NULL OR (
      parent_span_id ~ '^[0-9a-f]{16}$' AND parent_span_id <> span_id
    )) AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_tool_execution_trace_digest_check CHECK (
    invocation_plan_digest ~ '^[0-9a-f]{64}$' AND
    binding_digest ~ '^[0-9a-f]{64}$' AND
    adapter_digest ~ '^[0-9a-f]{64}$' AND
    redaction_contract_digest ~ '^[0-9a-f]{64}$' AND
    audit_contract_digest ~ '^[0-9a-f]{64}$' AND
    trace_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_execution_trace_time_check CHECK (
    created_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_execution_trace_json_check CHECK (
    jsonb_typeof(trace_json) = 'object' AND
    octet_length(trace_json::text) BETWEEN 2 AND 16384 AND
    trace_json @> jsonb_build_object(
      'schema', 'qinglong/tool-execution-trace-anchor@v1',
      'traceId', trace_id,
      'spanId', span_id,
      'parentSpanId', parent_span_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'invocationPlanDigest', invocation_plan_digest,
      'bindingDigest', binding_digest,
      'adapterDigest', adapter_digest,
      'redactionContractDigest', redaction_contract_digest,
      'auditContractDigest', audit_contract_digest,
      'createdAtMs', created_at_ms,
      'traceDigest', trace_digest
    )
  )
)
      `.trim(),
      `
CREATE INDEX ql3_tool_execution_trace_run_idx
ON "ql3"."tool_execution_trace_anchors"
  (run_id, created_at_ms, trace_id, span_id)
      `.trim(),
      `
CREATE INDEX ql3_tool_execution_trace_step_idx
ON "ql3"."tool_execution_trace_anchors"
  (run_id, step_run_id, created_at_ms, trace_id, span_id)
      `.trim(),
      `
CREATE TABLE "ql3"."tool_execution_audit_receipts" (
  event_id uuid PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  trace_id char(32) NOT NULL,
  span_id char(16) NOT NULL,
  trace_digest char(64) NOT NULL,
  invocation_plan_digest char(64) NOT NULL,
  binding_digest char(64) NOT NULL,
  audit_record_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  receipt_digest char(64) NOT NULL,
  audit_json jsonb NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_tool_execution_audit_event_fk
    FOREIGN KEY (event_id)
    REFERENCES "ql3"."security_audit_events" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_execution_audit_trace_fk
    FOREIGN KEY (trace_id, span_id)
    REFERENCES "ql3"."tool_execution_trace_anchors" (trace_id, span_id)
    ON DELETE CASCADE,
  CONSTRAINT ql3_tool_execution_audit_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE CASCADE,
  CONSTRAINT ql3_tool_execution_audit_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    trace_id ~ '^[0-9a-f]{32}$' AND
    span_id ~ '^[0-9a-f]{16}$'
  ),
  CONSTRAINT ql3_tool_execution_audit_digest_check CHECK (
    trace_digest ~ '^[0-9a-f]{64}$' AND
    invocation_plan_digest ~ '^[0-9a-f]{64}$' AND
    binding_digest ~ '^[0-9a-f]{64}$' AND
    audit_record_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_execution_audit_time_check CHECK (
    created_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_execution_audit_json_check CHECK (
    jsonb_typeof(audit_json) = 'object' AND
    octet_length(audit_json::text) BETWEEN 2 AND 8192 AND
    audit_json @> jsonb_build_object(
      'eventId', event_id,
      'projectId', project_id,
      'operationId', 'tool.invoke.start',
      'outcome', 'allowed',
      'occurredAtMs', created_at_ms
    ) AND
    jsonb_typeof(audit_json -> 'fence') = 'object'
  ),
  CONSTRAINT ql3_tool_execution_audit_receipt_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 16384 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/tool-execution-audit-receipt@v1',
      'eventId', event_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'traceId', trace_id,
      'spanId', span_id,
      'traceDigest', trace_digest,
      'invocationPlanDigest', invocation_plan_digest,
      'bindingDigest', binding_digest,
      'auditRecordDigest', audit_record_digest,
      'createdAtMs', created_at_ms,
      'receiptDigest', receipt_digest
    )
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_execution_audit_trace_uidx
ON "ql3"."tool_execution_audit_receipts" (trace_id, span_id)
      `.trim(),
      `
CREATE INDEX ql3_tool_execution_audit_run_idx
ON "ql3"."tool_execution_audit_receipts"
  (run_id, created_at_ms, trace_id, span_id)
      `.trim(),
      `
CREATE INDEX ql3_tool_execution_audit_step_idx
ON "ql3"."tool_execution_audit_receipts"
  (run_id, step_run_id, created_at_ms, event_id)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."tool_execution_trace_anchors",
   "ql3"."tool_execution_audit_receipts"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."tool_execution_trace_anchors",
   "ql3"."tool_execution_audit_receipts"
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 28,
      migration_id = 'pg-0029-tool-execution-evidence',
      capabilities = '${CAPABILITIES_V28}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 27
    AND migration_id = 'pg-0028-step-runs'
    AND capabilities = '${CAPABILITIES_V27}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 27'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
