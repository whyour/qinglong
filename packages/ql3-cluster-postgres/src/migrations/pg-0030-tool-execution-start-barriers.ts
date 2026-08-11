import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V28 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_evidence":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V29 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0030ToolExecutionStartBarriersMigration =
  definePostgresSqlMigration({
    id: 'pg-0030-tool-execution-start-barriers',
    statements: [
      `
CREATE TABLE "ql3"."tool_execution_start_barriers" (
  start_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  started_step_run_version integer NOT NULL,
  step_run_mutation_id varchar(128) NOT NULL,
  run_event_id varchar(128) NOT NULL,
  trace_id char(32) NOT NULL,
  span_id char(16) NOT NULL,
  audit_event_id uuid NOT NULL,
  command_digest char(64) NOT NULL,
  barrier_digest char(64) NOT NULL,
  started_at_ms bigint NOT NULL,
  barrier_json jsonb NOT NULL,
  CONSTRAINT ql3_tool_start_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_mutation_fk
    FOREIGN KEY (step_run_mutation_id)
    REFERENCES "ql3"."step_run_mutations" (mutation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_event_fk
    FOREIGN KEY (run_event_id)
    REFERENCES "ql3"."run_events" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_trace_fk
    FOREIGN KEY (trace_id, span_id)
    REFERENCES "ql3"."tool_execution_trace_anchors" (trace_id, span_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ql3"."tool_execution_audit_receipts" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_identity_check CHECK (
    start_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    trace_id ~ '^[0-9a-f]{32}$' AND span_id ~ '^[0-9a-f]{16}$'
  ),
  CONSTRAINT ql3_tool_start_version_time_check CHECK (
    started_step_run_version BETWEEN 2 AND 2147483647 AND
    started_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_start_digest_check CHECK (
    command_digest ~ '^[0-9a-f]{64}$' AND
    barrier_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_start_json_check CHECK (
    jsonb_typeof(barrier_json) = 'object' AND
    octet_length(barrier_json::text) BETWEEN 2 AND 16384 AND
    barrier_json @> jsonb_build_object(
      'schema', 'qinglong/tool-execution-start-barrier@v1',
      'startId', start_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'startedStepRunVersion', started_step_run_version,
      'stepRunMutationId', step_run_mutation_id,
      'runEventId', run_event_id,
      'traceId', trace_id,
      'spanId', span_id,
      'auditEventId', audit_event_id,
      'commandDigest', command_digest,
      'barrierDigest', barrier_digest,
      'startedAtMs', started_at_ms
    )
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_start_step_version_uidx
ON "ql3"."tool_execution_start_barriers"
  (run_id, step_run_id, started_step_run_version)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_start_mutation_uidx
ON "ql3"."tool_execution_start_barriers" (step_run_mutation_id)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_start_event_uidx
ON "ql3"."tool_execution_start_barriers" (run_event_id)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_start_trace_uidx
ON "ql3"."tool_execution_start_barriers" (trace_id, span_id)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_start_audit_uidx
ON "ql3"."tool_execution_start_barriers" (audit_event_id)
      `.trim(),
      `
CREATE INDEX ql3_tool_start_run_time_idx
ON "ql3"."tool_execution_start_barriers"
  (run_id, started_at_ms, start_id)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."tool_execution_start_barriers"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."tool_execution_start_barriers"
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 29,
      migration_id = 'pg-0030-tool-execution-start-barriers',
      capabilities = '${CAPABILITIES_V29}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 28
    AND migration_id = 'pg-0029-tool-execution-evidence'
    AND capabilities = '${CAPABILITIES_V28}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 28'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
