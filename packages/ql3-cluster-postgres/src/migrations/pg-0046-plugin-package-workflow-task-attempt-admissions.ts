import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V44 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V45 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_task_attempt_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0046PluginPackageWorkflowTaskAttemptAdmissionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0046-plugin-package-workflow-task-attempt-admissions',
    statements: [
      `
CREATE UNIQUE INDEX ql3_plugin_package_task_reconciliation_receipt_uidx
ON "ql3"."plugin_package_task_reconciliations"
  (generation_digest, receipt_digest)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_workflow_task_attempt_admissions" (
  receipt_digest char(64) PRIMARY KEY,
  attempt_id varchar(36) NOT NULL,
  plan_digest char(64) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  step_run_version integer NOT NULL,
  step_run_digest char(64) NOT NULL,
  generation_digest char(64) NOT NULL,
  resource_task_id varchar(128) NOT NULL,
  task_reconciliation_receipt_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  source_revision integer NOT NULL,
  task_revision varchar(96) NOT NULL,
  task_definition_digest char(64) NOT NULL,
  executor_type varchar(32) NOT NULL,
  execution_digest char(64) NOT NULL,
  attempt_number integer NOT NULL,
  event_id varchar(36) NOT NULL,
  run_version integer NOT NULL,
  run_event_sequence integer NOT NULL,
  admitted_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT plugin_package_workflow_task_attempt_admissions_attempt_id_key
    UNIQUE (attempt_id),
  CONSTRAINT plugin_package_workflow_task_attempt_admissions_event_id_key
    UNIQUE (event_id),
  CONSTRAINT plugin_package_workflow_task_attempt_admissions_epoch_key
    UNIQUE (run_id, step_run_id, step_run_version),
  CONSTRAINT plugin_package_workflow_task_attempt_admissions_number_key
    UNIQUE (run_id, attempt_number),
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_plan_fk
    FOREIGN KEY (plan_digest, run_id)
    REFERENCES "ql3"."plugin_package_workflow_admissions" (
      plan_digest, run_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_attempt_fk
    FOREIGN KEY (attempt_id)
    REFERENCES "ql3"."run_attempts" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_event_fk
    FOREIGN KEY (event_id)
    REFERENCES "ql3"."run_events" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_workflow_task_attempt_reconciliation_fk
    FOREIGN KEY (
      generation_digest, task_reconciliation_receipt_digest
    ) REFERENCES "ql3"."plugin_package_task_reconciliations" (
      generation_digest, receipt_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_execution_fk
    FOREIGN KEY (
      project_id, task_id, source_revision, executor_type
    ) REFERENCES "ql3"."task_execution_revisions" (
      project_id, task_id, source_revision, executor_type
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_workflow_task_attempt_identity_check
    CHECK (
      attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
      run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
      char_length(step_run_id) BETWEEN 1 AND 128 AND
      char_length(resource_task_id) BETWEEN 1 AND 128 AND
      char_length(project_id) BETWEEN 1 AND 128 AND
      char_length(task_id) BETWEEN 1 AND 128 AND
      event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
      executor_type = 'remote_worker'
    ),
  CONSTRAINT ql3_pp_workflow_task_attempt_counter_check
    CHECK (
      step_run_version BETWEEN 1 AND 2147483647 AND
      source_revision BETWEEN 1 AND 2147483647 AND
      attempt_number BETWEEN 1 AND 8192 AND
      run_version BETWEEN 1 AND 2147483647 AND
      run_event_sequence = run_version AND
      admitted_at_ms >= 0
    ),
  CONSTRAINT
    ql3_plugin_package_workflow_task_attempt_admission_digest_check
    CHECK (
      receipt_digest ~ '^[0-9a-f]{64}$' AND
      plan_digest ~ '^[0-9a-f]{64}$' AND
      step_run_digest ~ '^[0-9a-f]{64}$' AND
      generation_digest ~ '^[0-9a-f]{64}$' AND
      task_reconciliation_receipt_digest ~ '^[0-9a-f]{64}$' AND
      task_definition_digest ~ '^[0-9a-f]{64}$' AND
      execution_digest ~ '^[0-9a-f]{64}$' AND
      task_revision = concat(
        'qltd:v1:', source_revision::text, ':', task_definition_digest
      )
    ),
  CONSTRAINT
    ql3_plugin_package_workflow_task_attempt_admission_json_check
    CHECK (
      jsonb_typeof(receipt_json) = 'object' AND
      octet_length(receipt_json::text) BETWEEN 2 AND 16384 AND
      receipt_json @> jsonb_build_object(
        'schema',
          'qinglong/plugin-package-workflow-task-attempt-admission@v1',
        'receiptDigest', receipt_digest,
        'attemptId', attempt_id,
        'planDigest', plan_digest,
        'runId', run_id,
        'stepRunId', step_run_id,
        'stepRunVersion', step_run_version,
        'stepRunDigest', step_run_digest,
        'resourceTaskId', resource_task_id,
        'taskReconciliationReceiptDigest',
          task_reconciliation_receipt_digest,
        'taskId', task_id,
        'taskRevision', task_revision,
        'taskDefinitionDigest', task_definition_digest,
        'executorType', executor_type,
        'executionDigest', execution_digest,
        'attemptNumber', attempt_number,
        'eventId', event_id,
        'runVersion', run_version,
        'runEventSequence', run_event_sequence,
        'admittedAtMs', admitted_at_ms
      )
    )
)
      `.trim(),
      `
CREATE INDEX ql3_pp_workflow_task_attempt_candidate_idx
ON "ql3"."plugin_package_workflow_task_attempt_admissions"
  (run_id, step_run_id, admitted_at_ms)
      `.trim(),
      `
CREATE FUNCTION "ql3"."plugin_package_workflow_task_attempt_snapshot"(
  p_run_id varchar,
  p_step_run_id varchar
)
RETURNS TABLE(
  plan_json jsonb,
  reconciliation_json jsonb,
  execution_project_id varchar,
  execution_task_id varchar,
  execution_source_revision integer,
  execution_task_revision varchar,
  execution_source_content_digest char(64),
  execution_executor_type varchar,
  execution_plan_schema varchar,
  execution_plan_json jsonb,
  execution_content_digest char(64),
  execution_created_at_ms bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT
    workflow.plan_json,
    reconciliation.receipt_json,
    execution.project_id,
    execution.task_id,
    execution.source_revision,
    execution.task_revision,
    execution.source_content_digest,
    execution.executor_type,
    execution.plan_schema,
    execution.plan_json,
    execution.content_digest,
    execution.created_at_ms
  FROM "ql3"."plugin_package_workflow_admissions" AS workflow
  JOIN "ql3"."plugin_package_workflow_admission_steps" AS source
    ON source.plan_digest = workflow.plan_digest
   AND source.run_id = workflow.run_id
   AND source.step_run_id = p_step_run_id
  JOIN "ql3"."plugin_package_task_reconciliations" AS reconciliation
    ON reconciliation.generation_digest = workflow.generation_digest
  JOIN "ql3"."plugin_package_task_reconciliation_items" AS item
    ON item.generation_digest = reconciliation.generation_digest
   AND item.task_id =
     concat('pkg:', workflow.package_name, ':', source.task_id)
   AND item.disposition IN ('created', 'retained', 'updated')
  JOIN "ql3"."task_execution_revisions" AS execution
    ON execution.project_id = workflow.project_id
   AND execution.task_id = item.task_id
   AND execution.source_revision = item.revision
   AND execution.executor_type = 'remote_worker'
   AND execution.source_content_digest = item.content_digest
  WHERE workflow.run_id = p_run_id
  FOR KEY SHARE OF workflow, source, reconciliation, item, execution;
END
$ql3$
      `.trim(),
      `
REVOKE ALL
ON "ql3"."plugin_package_workflow_task_attempt_admissions"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_workflow_task_attempt_admissions"
TO ql3_runtime
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."plugin_package_workflow_task_attempt_snapshot"(varchar, varchar)
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT EXECUTE ON FUNCTION
  "ql3"."plugin_package_workflow_task_attempt_snapshot"(varchar, varchar)
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 45,
      migration_id =
        'pg-0046-plugin-package-workflow-task-attempt-admissions',
      capabilities = '${CAPABILITIES_V45}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 44
    AND migration_id = 'pg-0045-plugin-package-workflow-admissions'
    AND capabilities = '${CAPABILITIES_V44}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 44'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
