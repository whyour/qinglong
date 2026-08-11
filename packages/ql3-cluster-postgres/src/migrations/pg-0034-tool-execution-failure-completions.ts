import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V32 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V33 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0034ToolExecutionFailureCompletionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0034-tool-execution-failure-completions',
    statements: [
      `
CREATE TABLE "ql3"."tool_execution_failure_completions" (
  start_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(128) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  started_step_run_version integer NOT NULL,
  completed_step_run_version integer NOT NULL,
  barrier_digest char(64) NOT NULL,
  adapter_digest char(64) NOT NULL,
  outcome varchar(16) NOT NULL,
  result_code varchar(64) NOT NULL,
  error_summary varchar(128) NOT NULL,
  step_run_mutation_id varchar(128) NOT NULL,
  step_run_mutation_digest char(64) NOT NULL,
  completed_step_run_digest char(64) NOT NULL,
  run_event_id varchar(128) NOT NULL,
  completed_at_ms bigint NOT NULL,
  completion_digest char(64) NOT NULL,
  completion_json jsonb NOT NULL,
  CONSTRAINT ql3_tool_failure_completion_start_fk
    FOREIGN KEY (start_id)
    REFERENCES "ql3"."tool_execution_start_barriers" (start_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_mutation_fk
    FOREIGN KEY (step_run_mutation_id)
    REFERENCES "ql3"."step_run_mutations" (mutation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_event_fk
    FOREIGN KEY (run_event_id)
    REFERENCES "ql3"."run_events" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_identity_check CHECK (
    start_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_mutation_id ~
      '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_tool_failure_completion_version_check CHECK (
    started_step_run_version BETWEEN 2 AND 2147483646 AND
    completed_step_run_version = started_step_run_version + 1
  ),
  CONSTRAINT ql3_tool_failure_completion_digest_check CHECK (
    barrier_digest ~ '^[0-9a-f]{64}$' AND
    adapter_digest ~ '^[0-9a-f]{64}$' AND
    step_run_mutation_digest ~ '^[0-9a-f]{64}$' AND
    completed_step_run_digest ~ '^[0-9a-f]{64}$' AND
    completion_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_failure_completion_fact_check CHECK (
    (
      outcome = 'failed' AND
      result_code = 'tool_adapter_failed' AND
      error_summary = 'Trusted Tool execution failed'
    ) OR (
      outcome = 'timed_out' AND
      result_code = 'tool_deadline_exceeded' AND
      error_summary = 'Trusted Tool execution deadline exceeded'
    )
  ),
  CONSTRAINT ql3_tool_failure_completion_budget_check CHECK (
    completed_at_ms >= 0 AND
    octet_length(completion_json::text) BETWEEN 2 AND 24576
  ),
  CONSTRAINT ql3_tool_failure_completion_json_check CHECK (
    jsonb_typeof(completion_json) = 'object' AND
    completion_json @> jsonb_build_object(
      'schema', 'qinglong/tool-execution-failure-completion@v1',
      'startId', start_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'startedStepRunVersion', started_step_run_version,
      'completedStepRunVersion', completed_step_run_version,
      'barrierDigest', barrier_digest,
      'adapterDigest', adapter_digest,
      'outcome', outcome,
      'resultCode', result_code,
      'errorSummary', error_summary,
      'stepRunMutationId', step_run_mutation_id,
      'stepRunMutationDigest', step_run_mutation_digest,
      'completedStepRunDigest', completed_step_run_digest,
      'runEventId', run_event_id,
      'completedAtMs', completed_at_ms,
      'completionDigest', completion_digest
    )
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_failure_completion_mutation_uidx
ON "ql3"."tool_execution_failure_completions" (step_run_mutation_id)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_failure_completion_event_uidx
ON "ql3"."tool_execution_failure_completions" (run_event_id)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_failure_completion_step_version_uidx
ON "ql3"."tool_execution_failure_completions"
  (run_id, step_run_id, completed_step_run_version)
      `.trim(),
      `
CREATE INDEX ql3_tool_failure_completion_project_time_idx
ON "ql3"."tool_execution_failure_completions"
  (project_id, completed_at_ms, start_id)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."tool_execution_failure_completions"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."tool_execution_failure_completions"
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 33,
      migration_id = 'pg-0034-tool-execution-failure-completions',
      capabilities = '${CAPABILITIES_V33}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 32
    AND migration_id = 'pg-0033-tool-execution-completions'
    AND capabilities = '${CAPABILITIES_V32}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 32'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
