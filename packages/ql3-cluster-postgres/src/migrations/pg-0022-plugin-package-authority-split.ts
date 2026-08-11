import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V20 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_install":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V21 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_install":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0022PluginPackageAuthoritySplitMigration =
  definePostgresSqlMigration({
    id: 'pg-0022-plugin-package-authority-split',
    statements: [
      `
DO $ql3$
DECLARE
  invalid_roles text[];
BEGIN
  SELECT array_agg(expected.role_name ORDER BY expected.role_name)
  INTO invalid_roles
  FROM (
    VALUES
      ('ql3_package_manager'),
      ('ql3_package_executor')
  ) AS expected(role_name)
  LEFT JOIN pg_catalog.pg_roles roles
    ON roles.rolname = expected.role_name
  WHERE roles.rolname IS NULL
     OR roles.rolcanlogin IS NOT TRUE
     OR roles.rolsuper IS NOT FALSE
     OR roles.rolcreatedb IS NOT FALSE
     OR roles.rolcreaterole IS NOT FALSE
     OR roles.rolreplication IS NOT FALSE
     OR roles.rolbypassrls IS NOT FALSE;

  IF invalid_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'required QingLong Package database roles are missing or privileged: %',
      invalid_roles
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$ql3$
      `.trim(),
      `
DO $ql3$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ql3_package_manager, ql3_package_executor',
    current_database()
  );
END
$ql3$
      `.trim(),
      'GRANT USAGE ON SCHEMA "ql3" TO ql3_package_manager, ql3_package_executor',
      'GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities" TO ql3_package_manager, ql3_package_executor',
      `
REVOKE ALL
ON "ql3"."plugin_package_install_proposals",
   "ql3"."approval_requests",
   "ql3"."approved_action_dispatches",
   "ql3"."approved_action_executions",
   "ql3"."plugin_package_installs",
   "ql3"."plugin_package_install_heads",
   "ql3"."plugin_package_install_mutations",
   "ql3"."plugin_package_admission_receipts"
FROM ql3_admin
      `.trim(),
      `
REVOKE EXECUTE
ON FUNCTION "ql3"."lock_approval_policy_fence"(
  varchar, varchar, varchar, integer, integer
)
FROM ql3_admin
      `.trim(),
      `
REVOKE EXECUTE
ON FUNCTION "ql3"."lock_active_plugin_package_project"(varchar)
FROM ql3_admin
      `.trim(),
      `
GRANT SELECT
ON "ql3"."projects", "ql3"."project_role_bindings"
TO ql3_package_manager, ql3_package_executor
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."security_audit_events"
TO ql3_package_manager, ql3_package_executor
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_install_proposals"
TO ql3_package_manager
      `.trim(),
      `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."approval_requests"
TO ql3_package_manager
      `.trim(),
      `
GRANT EXECUTE
ON FUNCTION "ql3"."lock_approval_policy_fence"(
  varchar, varchar, varchar, integer, integer
)
TO ql3_package_manager, ql3_package_executor
      `.trim(),
      `
GRANT SELECT
ON "ql3"."plugin_package_install_proposals"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT, UPDATE
ON "ql3"."approval_requests"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."approved_action_dispatches"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."approved_action_executions",
   "ql3"."plugin_package_installs",
   "ql3"."plugin_package_install_heads"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_install_mutations",
   "ql3"."plugin_package_admission_receipts"
TO ql3_package_executor
      `.trim(),
      `
GRANT EXECUTE
ON FUNCTION "ql3"."lock_active_plugin_package_project"(varchar)
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 21,
      migration_id = 'pg-0022-plugin-package-authority-split',
      capabilities = '${CAPABILITIES_V21}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 20
    AND migration_id =
      'pg-0021-approved-action-executions-and-package-proposals'
    AND capabilities = '${CAPABILITIES_V20}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 20'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
