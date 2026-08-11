import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V29 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V30 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0031ToolInvocationArtifactsMigration =
  definePostgresSqlMigration({
    id: 'pg-0031-tool-invocation-artifacts',
    statements: [
      `
CREATE TABLE "ql3"."tool_invocation_input_artifacts" (
  artifact_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  action_ref varchar(255) NOT NULL,
  input_digest char(64) NOT NULL,
  invocation_action_digest char(64) NOT NULL,
  artifact_digest char(64) NOT NULL,
  key_id varchar(128) NOT NULL,
  algorithm varchar(32) NOT NULL,
  plaintext_bytes integer NOT NULL,
  sealed_at_ms bigint NOT NULL,
  artifact_json jsonb NOT NULL,
  CONSTRAINT ql3_tool_input_artifact_project_fk
    FOREIGN KEY (project_id)
    REFERENCES "ql3"."projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_input_artifact_identity_check CHECK (
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    algorithm = 'aes-256-gcm'
  ),
  CONSTRAINT ql3_tool_input_artifact_digest_check CHECK (
    input_digest ~ '^[0-9a-f]{64}$' AND
    invocation_action_digest ~ '^[0-9a-f]{64}$' AND
    artifact_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_input_artifact_budget_check CHECK (
    plaintext_bytes BETWEEN 0 AND 65536 AND sealed_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_input_artifact_json_check CHECK (
    jsonb_typeof(artifact_json) = 'object' AND
    octet_length(artifact_json::text) BETWEEN 2 AND 98304 AND
    artifact_json @> jsonb_build_object(
      'schema', 'qinglong/tool-invocation-input-artifact@v1',
      'artifactId', artifact_id,
      'projectId', project_id,
      'actionRef', action_ref,
      'inputDigest', input_digest,
      'invocationActionDigest', invocation_action_digest,
      'artifactDigest', artifact_digest,
      'keyId', key_id,
      'algorithm', algorithm,
      'plaintextBytes', plaintext_bytes,
      'sealedAtMs', sealed_at_ms
    )
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_input_artifact_action_uidx
ON "ql3"."tool_invocation_input_artifacts" (project_id, action_ref)
      `.trim(),
      `
CREATE INDEX ql3_tool_input_artifact_project_time_idx
ON "ql3"."tool_invocation_input_artifacts"
  (project_id, sealed_at_ms, artifact_id)
      `.trim(),
      `
CREATE TABLE "ql3"."tool_invocation_preview_artifacts" (
  artifact_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  action_ref varchar(255) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  redaction_contract_digest char(64) NOT NULL,
  artifact_digest char(64) NOT NULL,
  byte_length integer NOT NULL,
  sealed_at_ms bigint NOT NULL,
  artifact_json jsonb NOT NULL,
  CONSTRAINT ql3_tool_preview_artifact_project_fk
    FOREIGN KEY (project_id)
    REFERENCES "ql3"."projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_preview_artifact_identity_check CHECK (
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
  ),
  CONSTRAINT ql3_tool_preview_artifact_digest_check CHECK (
    action_digest ~ '^[0-9a-f]{64}$' AND
    preview_digest ~ '^[0-9a-f]{64}$' AND
    redaction_contract_digest ~ '^[0-9a-f]{64}$' AND
    artifact_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_preview_artifact_budget_check CHECK (
    byte_length BETWEEN 2 AND 8192 AND sealed_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_preview_artifact_json_check CHECK (
    jsonb_typeof(artifact_json) = 'object' AND
    octet_length(artifact_json::text) BETWEEN 2 AND 16384 AND
    artifact_json @> jsonb_build_object(
      'schema', 'qinglong/tool-invocation-preview-artifact@v1',
      'artifactId', artifact_id,
      'projectId', project_id,
      'actionRef', action_ref,
      'actionDigest', action_digest,
      'previewDigest', preview_digest,
      'redactionContractDigest', redaction_contract_digest,
      'artifactDigest', artifact_digest,
      'byteLength', byte_length,
      'sealedAtMs', sealed_at_ms
    )
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_preview_artifact_action_uidx
ON "ql3"."tool_invocation_preview_artifacts" (project_id, action_ref)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_tool_preview_artifact_action_digest_uidx
ON "ql3"."tool_invocation_preview_artifacts" (action_digest)
      `.trim(),
      `
CREATE INDEX ql3_tool_preview_artifact_project_time_idx
ON "ql3"."tool_invocation_preview_artifacts"
  (project_id, sealed_at_ms, artifact_id)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."tool_invocation_input_artifacts",
   "ql3"."tool_invocation_preview_artifacts"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."tool_invocation_input_artifacts",
   "ql3"."tool_invocation_preview_artifacts"
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 30,
      migration_id = 'pg-0031-tool-invocation-artifacts',
      capabilities = '${CAPABILITIES_V30}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 29
    AND migration_id = 'pg-0030-tool-execution-start-barriers'
    AND capabilities = '${CAPABILITIES_V29}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 29'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
