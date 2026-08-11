import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V40 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V41 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0042PluginPackageLifecyclePlansMigration =
  definePostgresSqlMigration({
    id: 'pg-0042-plugin-package-lifecycle-plans',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_lifecycle_plans" (
  action_ref varchar(255) PRIMARY KEY,
  plan_digest char(64) NOT NULL,
  action varchar(16) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  impact_digest char(64) NOT NULL,
  requested_by_type varchar(16) NOT NULL,
  requested_by_id varchar(255) NOT NULL,
  planned_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  plan_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_lifecycle_plan_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_plan_identity_check CHECK (
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
    AND action IN ('disable', 'enable', 'uninstall')
    AND package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    AND requested_by_type = 'user'
    AND char_length(requested_by_id) BETWEEN 1 AND 255
    AND requested_by_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_plan_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$'
    AND lock_digest ~ '^[0-9a-f]{64}$'
    AND impact_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_plan_time_check CHECK (
    planned_at_ms >= 0
    AND expires_at_ms > planned_at_ms
    AND expires_at_ms - planned_at_ms <= 900000
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_plan_json_check CHECK (
    jsonb_typeof(plan_json) = 'object'
    AND octet_length(plan_json::text) BETWEEN 2 AND 98304
    AND plan_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-lifecycle-plan@v1',
      'actionRef', action_ref,
      'planDigest', plan_digest,
      'requestedBy', jsonb_build_object(
        'type', requested_by_type,
        'id', requested_by_id
      ),
      'plannedAtMs', planned_at_ms,
      'expiresAtMs', expires_at_ms,
      'impact', jsonb_build_object(
        'action', action,
        'impactDigest', impact_digest,
        'target', jsonb_build_object(
          'projectId', project_id,
          'packageName', package_name,
          'installationId', installation_id,
          'lockDigest', lock_digest
        )
      )
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_plan_digest_key ON "ql3"."plugin_package_lifecycle_plans" (plan_digest)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_plan_impact_key ON "ql3"."plugin_package_lifecycle_plans" (project_id, package_name, installation_id, lock_digest, impact_digest)`,
      `CREATE INDEX ql3_plugin_package_lifecycle_plan_expiry_idx ON "ql3"."plugin_package_lifecycle_plans" (expires_at_ms, action_ref)`,
      `
REVOKE ALL ON "ql3"."plugin_package_lifecycle_plans"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `GRANT SELECT ON "ql3"."plugin_package_lifecycle_plans" TO ql3_package_manager, ql3_package_executor`,
      `GRANT INSERT ON "ql3"."plugin_package_lifecycle_plans" TO ql3_package_executor`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 41,
      migration_id = 'pg-0042-plugin-package-lifecycle-plans',
      capabilities = '${CAPABILITIES_V41}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 40
    AND migration_id = 'pg-0041-plugin-package-lifecycle'
    AND capabilities = '${CAPABILITIES_V40}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 40'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
