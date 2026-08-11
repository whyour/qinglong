import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V30 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V31 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0032ToolExecutionArtifactBindingsMigration =
  definePostgresSqlMigration({
    id: 'pg-0032-tool-execution-artifact-bindings',
    statements: [
      `
CREATE UNIQUE INDEX ql3_tool_input_artifact_start_binding_uidx
ON "ql3"."tool_invocation_input_artifacts" (
  artifact_id, artifact_digest, project_id, action_ref, input_digest
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_preview_artifact_start_binding_uidx
ON "ql3"."tool_invocation_preview_artifacts" (
  artifact_id, artifact_digest, project_id, action_ref, action_digest,
  preview_digest, redaction_contract_digest
)
      `.trim(),
      `
CREATE TABLE "ql3"."tool_execution_start_artifact_bindings" (
  start_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  action_ref varchar(255) NOT NULL,
  input_artifact_id varchar(128) NOT NULL,
  input_artifact_digest char(64) NOT NULL,
  input_digest char(64) NOT NULL,
  preview_artifact_id varchar(128) NOT NULL,
  preview_artifact_digest char(64) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  redaction_contract_digest char(64) NOT NULL,
  bound_at_ms bigint NOT NULL,
  CONSTRAINT ql3_tool_start_artifact_barrier_fk
    FOREIGN KEY (start_id)
    REFERENCES "ql3"."tool_execution_start_barriers" (start_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_input_artifact_fk
    FOREIGN KEY (
      input_artifact_id, input_artifact_digest, project_id, action_ref,
      input_digest
    )
    REFERENCES "ql3"."tool_invocation_input_artifacts" (
      artifact_id, artifact_digest, project_id, action_ref, input_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_preview_artifact_fk
    FOREIGN KEY (
      preview_artifact_id, preview_artifact_digest, project_id, action_ref,
      action_digest, preview_digest, redaction_contract_digest
    )
    REFERENCES "ql3"."tool_invocation_preview_artifacts" (
      artifact_id, artifact_digest, project_id, action_ref, action_digest,
      preview_digest, redaction_contract_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_artifact_identity_check CHECK (
    start_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
    input_artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    preview_artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_tool_start_artifact_digest_check CHECK (
    input_artifact_digest ~ '^[0-9a-f]{64}$' AND
    input_digest ~ '^[0-9a-f]{64}$' AND
    preview_artifact_digest ~ '^[0-9a-f]{64}$' AND
    action_digest ~ '^[0-9a-f]{64}$' AND
    preview_digest ~ '^[0-9a-f]{64}$' AND
    redaction_contract_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_start_artifact_time_check CHECK (bound_at_ms >= 0)
)
      `.trim(),
      `
CREATE INDEX ql3_tool_start_artifact_input_idx
ON "ql3"."tool_execution_start_artifact_bindings"
  (input_artifact_id, start_id)
      `.trim(),
      `
CREATE INDEX ql3_tool_start_artifact_preview_idx
ON "ql3"."tool_execution_start_artifact_bindings"
  (preview_artifact_id, start_id)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."tool_execution_start_artifact_bindings"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."tool_execution_start_artifact_bindings"
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 31,
      migration_id = 'pg-0032-tool-execution-artifact-bindings',
      capabilities = '${CAPABILITIES_V31}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 30
    AND migration_id = 'pg-0031-tool-invocation-artifacts'
    AND capabilities = '${CAPABILITIES_V30}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 30'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
