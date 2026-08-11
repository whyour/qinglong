import { CAPABILITIES_V49 } from './pg-0050-worker-credential-management-boundary';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V50 = CAPABILITIES_V49.replace(
  '"approved_action":1,',
  '"approved_action":1,"automation_management_boundary":1,',
);

export const pg0051AutomationManagementBoundaryMigration =
  definePostgresSqlMigration({
    id: 'pg-0051-automation-management-boundary',
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
    ON roles.rolname = 'ql3_automation_manager';

  IF role_invalid IS NOT FALSE THEN
    RAISE EXCEPTION
      'required QingLong automation manager role is missing or privileged'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$ql3$
      `.trim(),
      `
DO $ql3$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ql3_automation_manager',
    current_database()
  );
END
$ql3$
      `.trim(),
      `GRANT USAGE ON SCHEMA "ql3" TO ql3_automation_manager`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA "ql3" FROM ql3_automation_manager`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ql3" FROM ql3_automation_manager`,
      `GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities", "ql3"."projects", "ql3"."project_role_bindings", "ql3"."plugin_package_task_ownerships" TO ql3_automation_manager`,
      `GRANT SELECT, INSERT ON "ql3"."security_audit_events" TO ql3_automation_manager`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."task_definitions", "ql3"."triggers", "ql3"."trigger_schedules" TO ql3_automation_manager`,
      `GRANT SELECT, INSERT ON "ql3"."task_definition_revisions", "ql3"."task_execution_revisions", "ql3"."trigger_revisions" TO ql3_automation_manager`,
      `REVOKE SELECT, INSERT, UPDATE ON "ql3"."task_definitions", "ql3"."triggers", "ql3"."trigger_schedules" FROM ql3_admin`,
      `REVOKE SELECT, INSERT ON "ql3"."task_definition_revisions", "ql3"."task_execution_revisions", "ql3"."trigger_revisions" FROM ql3_admin`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 50,
      migration_id = 'pg-0051-automation-management-boundary',
      capabilities = '${CAPABILITIES_V50}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 49
    AND migration_id = 'pg-0050-worker-credential-management-boundary'
    AND capabilities = '${CAPABILITIES_V49}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 49'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
