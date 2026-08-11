import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V42 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V43 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0044PluginPackageAutomationStartGuardMigration =
  definePostgresSqlMigration({
    id: 'pg-0044-plugin-package-automation-start-guard',
    statements: [
      `
CREATE FUNCTION "ql3"."plugin_package_automation_start_allowed"(
  p_project_id varchar,
  p_package_name varchar,
  p_publication_digest char(64)
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  project_exists boolean;
  current_publication "ql3"."plugin_package_automation_publications"%ROWTYPE;
  current_lifecycle varchar(16);
  current_installation_id varchar(128);
  current_publisher varchar(253);
  current_key_id varchar(128);
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT true INTO project_exists
  FROM "ql3"."projects"
  WHERE id = p_project_id
  FOR SHARE;
  IF NOT COALESCE(project_exists, false) THEN
    RETURN false;
  END IF;

  SELECT publication.* INTO current_publication
  FROM "ql3"."plugin_package_automation_publication_heads" AS head
  JOIN "ql3"."plugin_package_automation_publications" AS publication
    ON publication.publication_digest = head.publication_digest
  WHERE head.project_id = p_project_id
    AND head.package_name = p_package_name
    AND head.publication_digest = p_publication_digest
  FOR SHARE OF head, publication;
  IF NOT FOUND OR current_publication.state <> 'active' THEN
    RETURN false;
  END IF;

  SELECT install.installation_id INTO current_installation_id
  FROM "ql3"."plugin_package_install_heads" AS head
  JOIN "ql3"."plugin_package_installs" AS install
    ON install.installation_id = head.installation_id
  WHERE head.project_id = current_publication.project_id
    AND head.package_name = current_publication.package_name
    AND head.installation_id = current_publication.installation_id
    AND install.lock_digest = current_publication.lock_digest
    AND install.state = 'active'
    AND install.active_lock_digest = current_publication.lock_digest
  FOR SHARE OF head, install;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT disposition INTO current_lifecycle
  FROM "ql3"."plugin_package_lifecycle_heads"
  WHERE project_id = current_publication.project_id
    AND package_name = current_publication.package_name
  FOR SHARE;
  IF FOUND AND current_lifecycle <> 'active' THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_quarantine_events" AS quarantine
    WHERE quarantine.project_id = current_publication.project_id
      AND quarantine.package_name = current_publication.package_name
      AND quarantine.installation_id =
        current_publication.installation_id
      AND quarantine.lock_digest = current_publication.lock_digest
  ) THEN
    RETURN false;
  END IF;

  SELECT provenance.publisher, provenance.key_id
    INTO current_publisher, current_key_id
  FROM "ql3"."plugin_package_publisher_provenance" AS provenance
  WHERE provenance.installation_id = current_publication.installation_id
    AND provenance.lock_digest = current_publication.lock_digest;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      octet_length(current_publisher)::text || ':' ||
      current_publisher ||
      octet_length(current_key_id)::text || ':' || current_key_id,
      774635230
    )
  );
  IF EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
    WHERE revoked.publisher = current_publisher
      AND revoked.key_id = current_key_id
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$ql3$
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."plugin_package_automation_start_allowed"(
    varchar, varchar, char(64)
  )
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT EXECUTE ON FUNCTION
  "ql3"."plugin_package_automation_start_allowed"(
    varchar, varchar, char(64)
  )
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 43,
      migration_id = 'pg-0044-plugin-package-automation-start-guard',
      capabilities = '${CAPABILITIES_V43}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 42
    AND migration_id = 'pg-0043-plugin-package-automation-publications'
    AND capabilities = '${CAPABILITIES_V42}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 42'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
