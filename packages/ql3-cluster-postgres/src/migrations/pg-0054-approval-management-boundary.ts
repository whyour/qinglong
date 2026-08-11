import { CAPABILITIES_V52 } from './pg-0053-plugin-package-workflow-run-list-index';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V53 = CAPABILITIES_V52.replace(
  '"approved_action":1,',
  '"approval_management_boundary":1,"approved_action":1,',
);

export const pg0054ApprovalManagementBoundaryMigration =
  definePostgresSqlMigration({
    id: 'pg-0054-approval-management-boundary',
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
    ON roles.rolname = 'ql3_approval_manager';

  IF role_invalid IS NOT FALSE THEN
    RAISE EXCEPTION
      'required QingLong approval manager role is missing or privileged'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$ql3$
      `.trim(),
      `
DO $ql3$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ql3_approval_manager',
    current_database()
  );
END
$ql3$
      `.trim(),
      `GRANT USAGE ON SCHEMA "ql3" TO ql3_approval_manager`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA "ql3" FROM ql3_approval_manager`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ql3" FROM ql3_approval_manager`,
      `GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities", "ql3"."projects", "ql3"."project_role_bindings", "ql3"."tool_invocation_preview_artifacts" TO ql3_approval_manager`,
      `GRANT SELECT, INSERT ON "ql3"."security_audit_events" TO ql3_approval_manager`,
      `GRANT SELECT, UPDATE ON "ql3"."approval_requests" TO ql3_approval_manager`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."plugin_package_identity_keyset_ledger" TO ql3_approval_manager`,
      `GRANT EXECUTE ON FUNCTION "ql3"."lock_approval_policy_fence"(varchar, varchar, varchar, integer, integer) TO ql3_approval_manager`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" DROP CONSTRAINT ql3_plugin_package_identity_keyset_authority_check`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" ADD CONSTRAINT ql3_plugin_package_identity_keyset_authority_check CHECK (authority IN ('plugin-package-management', 'worker-credential-management', 'automation-management', 'approval-management'))`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 53,
      migration_id = 'pg-0054-approval-management-boundary',
      capabilities = '${CAPABILITIES_V53}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 52
    AND migration_id = 'pg-0053-plugin-package-workflow-run-list-index'
    AND capabilities = '${CAPABILITIES_V52}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 52'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
