import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V48 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_task_attempt_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_execution_receipt":1,"worker_credential_management_plan":1,"worker_credential_preapproved_activation":1,"worker_credential_stage_discard":1,"worker_session":1}';
export const CAPABILITIES_V49 = CAPABILITIES_V48.replace(
  '"worker_credential_management_plan":1,',
  '"worker_credential_management_identity_keyset_ledger":1,"worker_credential_management_plan":1,"worker_credential_management_quota":1,',
);

export const pg0050WorkerCredentialManagementBoundaryMigration =
  definePostgresSqlMigration({
    id: 'pg-0050-worker-credential-management-boundary',
    statements: [
      `
CREATE TABLE "ql3"."worker_credential_management_quota_buckets" (
  project_id varchar(128) NOT NULL,
  subject_type varchar(32) NOT NULL,
  subject_id varchar(255) NOT NULL,
  operation varchar(64) NOT NULL,
  window_started_at_ms bigint NOT NULL,
  consumed_count integer NOT NULL,
  receipt_ids jsonb NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT worker_credential_management_quota_buckets_pkey
    PRIMARY KEY (project_id, subject_type, subject_id, operation),
  CONSTRAINT ql3_worker_credential_management_quota_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects"(id) ON DELETE RESTRICT,
  CONSTRAINT ql3_worker_credential_management_quota_identity_check
    CHECK (subject_type = 'user' AND char_length(subject_id) BETWEEN 1 AND 255
      AND subject_id !~ '[[:cntrl:]]'),
  CONSTRAINT ql3_worker_credential_management_quota_operation_check
    CHECK (operation IN ('worker-credential.plan', 'worker-credential.propose',
      'worker-credential.decide', 'worker-credential.inspect')),
  CONSTRAINT ql3_worker_credential_management_quota_window_check
    CHECK (window_started_at_ms >= 0 AND consumed_count BETWEEN 1 AND 1000
      AND updated_at_ms >= window_started_at_ms),
  CONSTRAINT ql3_worker_credential_management_quota_receipts_check
    CHECK (jsonb_typeof(receipt_ids) = 'array'
      AND jsonb_array_length(receipt_ids) = consumed_count
      AND octet_length(receipt_ids::text) BETWEEN 3 AND 262144)
)
      `.trim(),
      `REVOKE ALL ON "ql3"."worker_credential_management_quota_buckets" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress, ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."worker_credential_management_quota_buckets" TO ql3_worker_credential_manager`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" DROP CONSTRAINT ql3_plugin_package_identity_keyset_authority_check`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" ADD CONSTRAINT ql3_plugin_package_identity_keyset_authority_check CHECK (authority IN ('plugin-package-management', 'worker-credential-management'))`,
      `REVOKE ALL ON "ql3"."plugin_package_identity_keyset_ledger" FROM ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."plugin_package_identity_keyset_ledger" TO ql3_worker_credential_manager`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 49,
      migration_id = 'pg-0050-worker-credential-management-boundary',
      capabilities = '${CAPABILITIES_V49}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 48
    AND migration_id = 'pg-0049-worker-credential-execution-receipts'
    AND capabilities = '${CAPABILITIES_V48}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 48'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
