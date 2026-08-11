import { CAPABILITIES_V54 } from '../migrations/pg-0055-run-attempt-log-retention';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V55 = CAPABILITIES_V54.replace(
  '"run_core":1,',
  '"run_management_boundary":1,"run_core":1,',
);

export const pg0056RunManagementBoundaryMigration =
  definePostgresSqlMigration({
    id: 'pg-0056-run-management-boundary',
    statements: [
      `
DO $ql3$
DECLARE
  role_invalid boolean;
BEGIN
  SELECT roles.rolname IS NULL
      OR roles.rolcanlogin IS NOT TRUE
      OR roles.rolsuper IS NOT FALSE
      OR roles.rolcreatedb IS NOT FALSE
      OR roles.rolcreaterole IS NOT FALSE
      OR roles.rolreplication IS NOT FALSE
      OR roles.rolbypassrls IS NOT FALSE
  INTO role_invalid
  FROM (SELECT 1) AS expected
  LEFT JOIN pg_catalog.pg_roles AS roles
    ON roles.rolname = 'ql3_run_manager';

  IF role_invalid IS NOT FALSE THEN
    RAISE EXCEPTION
      'required QingLong run manager role is missing or privileged'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$ql3$
      `.trim(),
      `
DO $ql3$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ql3_run_manager',
    current_database()
  );
END
$ql3$
      `.trim(),
      `GRANT USAGE ON SCHEMA "ql3" TO ql3_run_manager`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA "ql3" FROM ql3_run_manager`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ql3" FROM ql3_run_manager`,
      `
CREATE FUNCTION "ql3"."lock_run_management_policy_fence"(
  varchar,
  varchar,
  varchar,
  integer,
  integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  project_status varchar;
  project_version integer;
  binding_state varchar;
  binding_role varchar;
  binding_version integer;
BEGIN
  SELECT project.status, project.version
  INTO project_status, project_version
  FROM "ql3"."projects" AS project
  WHERE project.id = $1
  FOR UPDATE;

  SELECT binding.state, binding.role, binding.version
  INTO binding_state, binding_role, binding_version
  FROM "ql3"."project_role_bindings" AS binding
  WHERE binding.project_id = $1
    AND binding.subject_type = $2
    AND binding.subject_id = $3
  ORDER BY binding.version DESC
  LIMIT 1;

  RETURN project_status = 'active'
    AND project_version = $4
    AND binding_state = 'active'
    AND binding_role IN ('owner', 'admin', 'operator')
    AND binding_version = $5;
END
$ql3$
      `.trim(),
      `REVOKE ALL ON FUNCTION "ql3"."lock_run_management_policy_fence"(varchar, varchar, varchar, integer, integer) FROM PUBLIC`,
      `GRANT EXECUTE ON FUNCTION "ql3"."lock_run_management_policy_fence"(varchar, varchar, varchar, integer, integer) TO ql3_runtime, ql3_run_manager`,
      `GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities", "ql3"."projects", "ql3"."project_role_bindings", "ql3"."task_definitions", "ql3"."task_definition_revisions", "ql3"."task_execution_revisions" TO ql3_run_manager`,
      `GRANT SELECT, INSERT ON "ql3"."runs", "ql3"."run_attempts", "ql3"."run_events", "ql3"."security_audit_events" TO ql3_run_manager`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."plugin_package_identity_keyset_ledger" TO ql3_run_manager`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" DROP CONSTRAINT ql3_plugin_package_identity_keyset_authority_check`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" ADD CONSTRAINT ql3_plugin_package_identity_keyset_authority_check CHECK (authority IN ('plugin-package-management', 'worker-credential-management', 'automation-management', 'approval-management', 'run-management'))`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 55,
      migration_id = 'pg-0056-run-management-boundary',
      capabilities = '${CAPABILITIES_V55}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 54
    AND migration_id = 'pg-0055-run-attempt-log-retention'
    AND capabilities = '${CAPABILITIES_V54}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 54'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
