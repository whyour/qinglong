import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V47 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_task_attempt_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_management_plan":1,"worker_credential_preapproved_activation":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V48 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_task_attempt_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_execution_receipt":1,"worker_credential_management_plan":1,"worker_credential_preapproved_activation":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0049WorkerCredentialExecutionReceiptsMigration =
  definePostgresSqlMigration({
    id: 'pg-0049-worker-credential-execution-receipts',
    statements: [
      `REVOKE ALL ON "ql3"."approved_action_executions" FROM ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."approved_action_executions" TO ql3_worker_credential_executor`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 48,
      migration_id = 'pg-0049-worker-credential-execution-receipts',
      capabilities = '${CAPABILITIES_V48}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 47
    AND migration_id = 'pg-0048-worker-credential-preapproved-activation'
    AND capabilities = '${CAPABILITIES_V47}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 47'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
